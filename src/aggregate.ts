// src/aggregator.ts
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

type Slice = {
  match_id: string;
  platform: string;
  region: string;
  patch: string;
  placement: number;
  units: Array<{ character_id: string; items: Array<number | string> }>;
};

type CompCounts = {
  patch: string;
  comp_key: string;
  picks: number;
  wins: number;
  sumPlacement: number;
  unit_set: string[];
  units: Map<string, Map<string, number>>; // unit -> item -> count
};

const {
  PATCH = "15.4",
  MIN_PICKS = "200",
  MIN_PICKS_ITEM_COMBO = "50",
} = process.env as Record<string, string>;

function compSignature(units: Array<{ character_id: string }>) {
  const set = [...new Set(units.map((u) => u.character_id))].sort();
  return set.join(",");
}
function unitSet(units: Array<{ character_id: string }>) {
  return [...new Set(units.map((u) => u.character_id))].sort();
}
function combosOf3(items: string[]): string[] {
  const uniq = [...new Set(items)].sort();
  const out: string[] = [];
  for (let i = 0; i < uniq.length; i++)
    for (let j = i + 1; j < uniq.length; j++)
      for (let k = j + 1; k < uniq.length; k++)
        out.push(`${uniq[i]}|${uniq[j]}|${uniq[k]}`);
  return out;
}

async function readAllSlices(): Promise<Slice[]> {
  const dir = path.join("data", "staging", "all");
  const out: Slice[] = [];
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ndjson"));
    for (const f of files) {
      const txt = await fs.readFile(path.join(dir, f), "utf8");
      for (const line of txt.split("\n")) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line) as Slice;
          if (s.patch === PATCH) out.push(s);
        } catch {}
      }
    }
  } catch {}
  return out;
}

async function run() {
  const slices = await readAllSlices();

  const compBuckets = new Map<string, CompCounts>();
  const unitCombos = new Map<
    string,
    Map<string, { picks: number; wins: number; sumPlacement: number }>
  >();

  for (const s of slices) {
    // comps
    const key = `${s.patch}::${compSignature(s.units as any)}`;
    let bag = compBuckets.get(key);
    if (!bag) {
      bag = {
        patch: s.patch,
        comp_key: key.split("::")[1],
        picks: 0,
        wins: 0,
        sumPlacement: 0,
        unit_set: unitSet(s.units as any),
        units: new Map(),
      };
      compBuckets.set(key, bag);
    }
    bag.picks += 1;
    if (s.placement === 1) bag.wins += 1;
    bag.sumPlacement += s.placement ?? 9;
    for (const u of s.units) {
      let m = bag.units.get(u.character_id);
      if (!m) {
        m = new Map();
        bag.units.set(u.character_id, m);
      }
      for (const it of (u.items || []).map(String)) {
        m.set(it, (m.get(it) || 0) + 1);
      }
    }

    // unit 3-item combos (independent of comp)
    for (const u of s.units) {
      const items = (u.items || []).map(String);
      if (items.length < 3) continue;
      const combos = combosOf3(items);
      let dest = unitCombos.get(u.character_id);
      if (!dest) {
        dest = new Map();
        unitCombos.set(u.character_id, dest);
      }
      for (const c of combos) {
        const cur = dest.get(c) || { picks: 0, wins: 0, sumPlacement: 0 };
        cur.picks += 1;
        if (s.placement === 1) cur.wins += 1;
        cur.sumPlacement += s.placement ?? 9;
        dest.set(c, cur);
      }
    }
  }

  const comps_top20 = [...compBuckets.values()]
    .filter((c) => c.picks >= Number(MIN_PICKS))
    .map((c) => {
      const units = [...c.units.entries()].map(([unit, freq]) => {
        const total = [...freq.values()].reduce((a, b) => a + b, 0) || 1;
        const item_freq = [...freq.entries()].map(
          ([item, n]) => [item, n / total] as [string, number]
        );
        const top_items = [...freq.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([item]) => item);
        return { character_id: unit, item_freq, top_items };
      });
      return {
        avg_placement: +(c.sumPlacement / c.picks).toFixed(2),
        picks: c.picks,
        winrate: +((c.wins / c.picks) * 100).toFixed(1),
        unit_set: c.unit_set,
        units,
      };
    })
    .sort((a, b) => a.avg_placement - b.avg_placement || b.picks - a.picks)
    .slice(0, 20);

  const unit_item_meta = [...unitCombos.entries()]
    .map(([unit, bag]) => {
      const combos = [...bag.entries()]
        .filter(([, v]) => v.picks >= Number(MIN_PICKS_ITEM_COMBO))
        .map(([combo, v]) => ({
          combo: combo.split("|"),
          picks: v.picks,
          avg_placement: +(v.sumPlacement / v.picks).toFixed(2),
          winrate: +((v.wins / v.picks) * 100).toFixed(1),
        }))
        .sort((a, b) => a.avg_placement - b.avg_placement || b.picks - a.picks)
        .slice(0, 10);
      return combos.length ? { unit, combos } : null;
    })
    .filter(Boolean);

  const payload = {
    generated_at: new Date().toISOString(),
    patch: PATCH,
    thresholds: {
      min_picks_comp: Number(MIN_PICKS),
      min_picks_item_combo: Number(MIN_PICKS_ITEM_COMBO),
    },
    comps_top20,
    unit_item_meta,
  };

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/meta_current.json", JSON.stringify(payload, null, 2));
  await fs.writeFile(`data/meta_${PATCH}.json`, JSON.stringify(payload, null, 2));
  console.log(
    `[Aggregator] Wrote data/meta_current.json with ${comps_top20.length} comps and ${unit_item_meta.length} units`
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
