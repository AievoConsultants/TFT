// Aggregation for comps (by avg placement) + separate unit 3-item combo meta.

export type ItemKey = number | string; // accept numeric IDs or names
export type Unit = { character_id: string; items: ItemKey[] };
export type Participant = { placement: number; units: Unit[] };
export type MatchInfo = { game_version: string; participants: Participant[] };

export type CompKey = string;

export function normalizePatch(v: string): string {
  const m = v?.match?.(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : v ?? "unknown";
}

// Signature: units + their item multiset (so forks like AD/AP split)
export function compSignature(units: Unit[]): CompKey {
  const sig = (units || [])
    .map(u => `${u.character_id}:${[...(u.items||[])].map(String).sort().join(".")}`)
    .sort()
    .join("|");
  return sig;
}
export function unitSet(units: Unit[]): string[] {
  return [...new Set((units||[]).map(u => u.character_id))].sort();
}

type ItemCount = Map<string, number>;            // item id -> count
type UnitBag = Map<string, ItemCount>;           // character_id -> ItemCount

export type CompCounts = {
  patch: string;
  comp_key: CompKey;
  picks: number;
  wins: number;
  sumPlacement: number;
  units: UnitBag;
  unit_set: string[];
};

export type CompRow = {
  patch: string;
  comp_key: CompKey;
  picks: number;
  avg_placement: number;
  winrate: number;
  unit_set: string[];
  units: Array<{
    character_id: string;
    top_items: string[];                // top 3 items by frequency
    item_freq: Array<[string, number]>; // [itemKey, probability]
  }>;
};

// --------- Unit 3-item combos (independent of comp) ---------
export type ComboKey = string; // e.g., "DB|IE|GS" (sorted names or numeric strings)
export type ComboCounts = { picks: number; wins: number; sumPlacement: number };
export type UnitComboBag = Map<string, Map<ComboKey, ComboCounts>>; // unit -> comboKey -> counts

function inc(map: ItemCount, k: string, v = 1) { map.set(k, (map.get(k)||0)+v); }
function freqFromCounts(counts: ItemCount): Array<[string, number]> {
  let total = 0; for (const c of counts.values()) total += c;
  const out: Array<[string, number]> = [];
  for (const [id, c] of counts.entries()) out.push([id, total ? c/total : 0]);
  out.sort((a,b)=>b[1]-a[1]); return out;
}

function combosOf3(items: string[]): string[] {
  // unique sorted combos of size 3
  const uniq = [...new Set(items)];
  uniq.sort();
  const out: string[] = [];
  for (let i=0;i<uniq.length;i++)
    for (let j=i+1;j<uniq.length;j++)
      for (let k=j+1;k<uniq.length;k++)
        out.push(`${uniq[i]}|${uniq[j]}|${uniq[k]}`);
  return out;
}

// ------- Aggregate both comp counts and unit combo counts -------
export function aggregateCountsAndCombos(matches: any[], patchFilter: string) {
  const compBuckets = new Map<string, CompCounts>(); // key: `${patch}::${comp_key}`
  const unitCombos: UnitComboBag = new Map();

  for (const m of matches) {
    const info: MatchInfo = m?.info;
    if (!info?.participants) continue;
    const patch = normalizePatch(info.game_version);
    if (patchFilter && patch !== patchFilter) continue;

    for (const p of info.participants) {
      const units: Unit[] = (p.units || []).map((u: any) => ({
        character_id: u.character_id,
        items: Array.isArray(u.items)
          ? (u.items as ItemKey[])
          : Array.isArray(u.itemNames) ? (u.itemNames as ItemKey[]) : []
      }));

      // --- comp counts ---
      const key = `${patch}::${compSignature(units)}`;
      let bag = compBuckets.get(key);
      if (!bag) {
        bag = {
          patch, comp_key: key.split("::")[1],
          picks: 0, wins: 0, sumPlacement: 0,
          units: new Map(), unit_set: unitSet(units)
        };
        compBuckets.set(key, bag);
      }
      bag.picks += 1;
      if (p.placement === 1) bag.wins += 1;
      bag.sumPlacement += p.placement ?? 9;
      for (const u of units) {
        let itemBag = bag.units.get(u.character_id);
        if (!itemBag) { itemBag = new Map(); bag.units.set(u.character_id, itemBag); }
        for (const it of (u.items || [])) inc(itemBag, String(it));
      }

      // --- unit 3-item combos (independent of comp) ---
      for (const u of units) {
        const items = (u.items || []).map(String);
        if (items.length < 3) continue;
        const combos = combosOf3(items);
        if (combos.length === 0) continue;

        let unitBag = unitCombos.get(u.character_id);
        if (!unitBag) { unitBag = new Map(); unitCombos.set(u.character_id, unitBag); }

        for (const cKey of combos) {
          let c = unitBag.get(cKey);
          if (!c) { c = { picks: 0, wins: 0, sumPlacement: 0 }; unitBag.set(cKey, c); }
          c.picks += 1;
          if (p.placement === 1) c.wins += 1;
          c.sumPlacement += p.placement ?? 9;
        }
      }
    }
  }

  return { compBuckets, unitCombos };
}

export function finalizeComps(compBuckets: Map<string, CompCounts>, minPicks: number): CompRow[] {
  const out: CompRow[] = [];
  for (const [, c] of compBuckets) {
    if (c.picks < minPicks) continue;
    const units = Array.from(c.units.entries()).map(([cid, bag]) => {
      const freq = freqFromCounts(bag);
      return {
        character_id: cid,
        top_items: freq.slice(0,3).map(([id])=>id),
        item_freq: freq
      };
    });
    out.push({
      patch: c.patch,
      comp_key: c.comp_key,
      picks: c.picks,
      avg_placement: +(c.sumPlacement / c.picks).toFixed(2),
      winrate: +(c.wins / c.picks * 100).toFixed(1),
      unit_set: c.unit_set,
      units
    });
  }
  out.sort((a,b)=> a.avg_placement - b.avg_placement || b.picks - a.picks);
  return out.slice(0, 20);
}

export type UnitComboRow = {
  unit: string;
  combos: Array<{
    combo: string[];       // 3 items in sorted order
    picks: number;
    avg_placement: number;
    winrate: number;
  }>;
};

export function finalizeUnitCombos(
  unitCombos: UnitComboBag,
  minPicksItemCombo: number,
  topN = 10
): UnitComboRow[] {
  const out: UnitComboRow[] = [];
  for (const [unit, bag] of unitCombos) {
    const rows = [] as UnitComboRow["combos"];
    for (const [cKey, c] of bag) {
      if (c.picks < minPicksItemCombo) continue;
      rows.push({
        combo: cKey.split("|"),
        picks: c.picks,
        avg_placement: +(c.sumPlacement / c.picks).toFixed(2),
        winrate: +(c.wins / c.picks * 100).toFixed(1)
      });
    }
    rows.sort((a,b)=> a.avg_placement - b.avg_placement || b.picks - a.picks);
    out.push({ unit, combos: rows.slice(0, topN) });
  }
  // Keep units with at least one combo
  return out.filter(u => u.combos.length > 0);
}

// ----- merging state across runs (same patch only) -----

export function mergeCompBuckets(
  base: Map<string, CompCounts>,
  add: Map<string, CompCounts>
) {
  for (const [k, c] of add) {
    const cur = base.get(k);
    if (!cur) { base.set(k, c); continue; }
    cur.picks += c.picks;
    cur.wins += c.wins;
    cur.sumPlacement += c.sumPlacement;
    for (const [cid, bag] of c.units) {
      let dest = cur.units.get(cid);
      if (!dest) { dest = new Map(); cur.units.set(cid, dest); }
      for (const [item, cnt] of bag) dest.set(item, (dest.get(item)||0)+cnt);
    }
  }
  return base;
}

export function mergeUnitCombos(
  base: UnitComboBag,
  add: UnitComboBag
) {
  for (const [unit, bag] of add) {
    let dest = base.get(unit);
    if (!dest) { dest = new Map(); base.set(unit, dest); }
    for (const [combo, c] of bag) {
      const cur = dest.get(combo);
      if (!cur) { dest.set(combo, { ...c }); }
      else {
        cur.picks += c.picks;
        cur.wins += c.wins;
        cur.sumPlacement += c.sumPlacement;
      }
    }
  }
  return base;
}
