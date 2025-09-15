import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { finalizeComps, finalizeUnitCombos, CompCounts, compSignature, unitSet } from "./aggregate.js";

type Slice = {
  match_id: string;
  platform: string;
  region: string;
  patch: string;
  placement: number;
  units: Array<{ character_id: string; items: Array<number|string> }>;
};

function combosOf3(items: string[]): string[] {
  const uniq = [...new Set(items.map(String))].sort();
  const out: string[] = [];
  for (let i=0;i<uniq.length;i++)
    for (let j=i+1;j<uniq.length;j++)
      for (let k=j+1;k<uniq.length;k++)
        out.push(`${uniq[i]}|${uniq[j]}|${uniq[k]}`);
  return out;
}

const {
  PATCH = "",
  MIN_PICKS = "200",
  MIN_PICKS_ITEM_COMBO = "50"
} = process.env as Record<string,string>;

async function readAllSlices(): Promise<Slice[]> {
  const patchDir = PATCH ? PATCH : "all";
  const dir = path.join("data","staging", patchDir);
  try {
    const entries = await fs.readdir(dir);
    const files = entries.filter(f => f.endsWith(".ndjson"));
    const all: Slice[] = [];
    for (const f of files) {
      const txt = await fs.readFile(path.join(dir,f), "utf8");
      for (const line of txt.split("\n")) {
        if (!line.trim()) continue;
        try { all.push(JSON.parse(line)); } catch {}
      }
    }
    return all;
  } catch {
    return [];
  }
}

async function run() {
  const slices = await readAllSlices();
  if (slices.length === 0) {
    console.error(`[Aggregator] No slices found. Did the collector run?`);
  }

  // comp buckets
  const compBuckets = new Map<string, CompCounts>();
  // unit 3-item combos
  const unitCombos = new Map<string, Map<string, {picks:number;wins:number;sumPlacement:number}>>();

  for (const s of slices) {
    if (PATCH && s.patch !== PATCH) continue;

    // comp aggregation
    const key = `${s.patch}::${compSignature(s.units as any)}`;
    let bag = compBuckets.get(key);
    if (!bag) {
      bag = { patch: s.patch, comp_key: key.split("::")[1], picks: 0, wins: 0, sumPlacement: 0, units: new Map(), unit_set: unitSet(s.units as any) };
      compBuckets.set(key, bag);
    }
    bag.picks += 1;
    if (s.placement === 1) bag.wins += 1;
    bag.sumPlacement += s.placement ?? 9;
    for (const u of s.units) {
      let itemBag = bag.units.get(u.character_id);
      if (!itemBag) { itemBag = new Map(); bag.units.set(u.character_id, itemBag); }
      for (const it of (u.items||[])) itemBag.set(String(it), (itemBag.get(String(it))||0)+1);
    }

    // unit combos (independent of comp)
    for (const u of s.units) {
      const items = (u.items||[]).map(String);
      if (items.length < 3) continue;
      const combos = combosOf3(items);
      let dest = unitCombos.get(u.character_id);
      if (!dest) { dest = new Map(); unitCombos.set(u.character_id, dest); }
      for (const c of combos) {
        const cur = dest.get(c) || { picks: 0, wins: 0, sumPlacement: 0 };
        cur.picks += 1;
        if (s.placement === 1) cur.wins += 1;
        cur.sumPlacement += s.placement ?? 9;
        dest.set(c, cur);
      }
    }
  }

  const comps_top20 = finalizeComps(compBuckets, Number(MIN_PICKS));
  const unit_item_meta = (function () {
    const rows: Array<{ unit: string; combos: Array<{ combo: string[]; picks: number; avg_placement: number; winrate: number }> }> = [];
    for (const [unit, bag] of unitCombos) {
      const list: any[] = [];
      for (const [combo, c] of bag) {
        if (c.picks < Number(MIN_PICKS_ITEM_COMBO)) continue;
        list.push({
          combo: combo.split("|"),
          picks: c.picks,
          avg_placement: +(c.sumPlacement / c.picks).toFixed(2),
          winrate: +(c.wins / c.picks * 100).toFixed(1)
        });
      }
      list.sort((a,b)=> a.avg_placement - b.avg_placement || b.picks - a.picks);
      if (list.length) rows.push({ unit, combos: list.slice(0,10) });
    }
    return rows;
  })();

  await fs.mkdir("data", { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    patch: PATCH || "(mixed)",
    thresholds: { min_picks_comp: Number(MIN_PICKS), min_picks_item_combo: Number(MIN_PICKS_ITEM_COMBO) },
    comps_top20,
    unit_item_meta
  };
  await fs.writeFile(path.join("data","meta_current.json"), JSON.stringify(payload, null, 2));
  await fs.writeFile(path.join("data", `meta_${PATCH || "mixed"}.json`), JSON.stringify(payload, null, 2));
  console.log(`[Aggregator] Wrote data/meta_current.json with ${comps_top20.length} comps and ${unit_item_meta.length} units`);
}

run().catch(e => { console.error(e); process.exit(1); });
