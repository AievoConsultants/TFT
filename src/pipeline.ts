import "dotenv/config";
import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import {
  leagueEntriesPaged, leagueListMasterPlus, summonerById,
  matchIdsByPuuid, getMatch, Platform, Region
} from "./riot.js";
import {
  aggregateCountsAndCombos, finalizeComps, finalizeUnitCombos,
  mergeCompBuckets, mergeUnitCombos, CompCounts, UnitComboRow
} from "./aggregate.js";

// ----- Config from env -----
const {
  RIOT_API_KEY,
  PATCH = "15.4",
  PLATFORMS = "NA1,EUW1,KR",
  SEED_SUMMONERS = "1500",
  MATCHES_PER = "20",
  MIN_PICKS = "200",
  MIN_PICKS_ITEM_COMBO = "50"
} = process.env as Record<string, string>;

if (!RIOT_API_KEY) { console.error("Missing RIOT_API_KEY"); process.exit(1); }

// ----- Platform -> Region mapping (we only use NA1, EUW1, KR per your choice) -----
function regionFor(p: Platform): Region {
  if (p === "NA1" || p === "BR1" || p === "LA1" || p === "LA2") return "AMERICAS";
  if (p === "EUW1" || p === "EUN1" || p === "TR1" || p === "RU") return "EUROPE";
  return "ASIA"; // KR, JP1, OC1
}

// ----- Seeding helpers -----
async function seedSummonerIdsForPlatform(platform: Platform) {
  const ids: string[] = [];

  // Masters+
  for (const tier of ["CHALLENGER", "GRANDMASTER", "MASTER"] as const) {
    try {
      const entries = await leagueListMasterPlus(platform, tier, RIOT_API_KEY);
      for (const e of entries) ids.push(e.summonerId);
    } catch {}
  }

  // Diamond (I..IV, pages 1..N)
  const pages = 10; // be greedy; we’ll cap by SEED_SUMMONERS later
  for (const div of ["I","II","III","IV"] as const) {
    for (let page=1; page<=pages; page++) {
      try {
        const pageRows = await leagueEntriesPaged(platform, "DIAMOND", div, page, RIOT_API_KEY);
        if (!pageRows || pageRows.length === 0) break;
        for (const e of pageRows) ids.push(e.summonerId);
      } catch { break; }
    }
  }

  // de-dupe
  return [...new Set(ids)];
}

async function toPuuids(platform: Platform, ids: string[], cap: number) {
  const limit = pLimit(16);
  const out = await Promise.all(ids.slice(0, cap).map(id =>
    limit(async () => {
      try { const s = await summonerById(platform, id, RIOT_API_KEY); return s.puuid; }
      catch { return null; }
    })
  ));
  return [...new Set(out.filter(Boolean) as string[])];
}

// ----- Match pulling -----
async function pullMatchesForPlatform(platform: Platform, puuids: string[], per: number) {
  const region = regionFor(platform);
  const limitIds = pLimit(16);
  const idSet = new Set<string>();

  await Promise.all(puuids.map(puuid =>
    limitIds(async () => {
      try {
        const arr = await matchIdsByPuuid(region, puuid, per, RIOT_API_KEY);
        for (const id of arr) idSet.add(id);
      } catch {} // skip 429/other errors
    })
  ));

  const limitMatch = pLimit(8);
  const matches = (await Promise.all([...idSet].map(id =>
    limitMatch(async () => {
      try { return await getMatch(region, id, RIOT_API_KEY); }
      catch { return null; }
    })
  ))).filter(Boolean);

  return matches as any[];
}

// ----- State load/save (single combined file) -----
const outDir = "data";
const versionedName = `meta_${PATCH}.json`;
const currentName = `meta_current.json`;
const outPathVersioned = path.join(outDir, versionedName);
const outPathCurrent  = path.join(outDir, currentName);

type RawState = {
  patch: string;
  __comp: Array<{
    key: string; patch: string; picks: number; wins: number; sumPlacement: number;
    unit_set: string[]; units: Array<[string, Array<[string, number]>]>; // [cid, [[item,count],...]]
  }>;
  __unitCombos: Array<{
    unit: string; combos: Array<[string, {picks:number;wins:number;sumPlacement:number}]>;
  }>;
};

async function loadPrevRaw(): Promise<RawState | null> {
  try {
    const raw = await fs.readFile(outPathVersioned, "utf8");
    return JSON.parse(raw) as RawState;
  } catch { return null; }
}

function serializeCompBuckets(map: Map<string, CompCounts>) {
  return [...map.entries()].map(([key, c]) => ({
    key, patch: c.patch, picks: c.picks, wins: c.wins, sumPlacement: c.sumPlacement, unit_set: c.unit_set,
    units: [...c.units.entries()].map(([cid, bag]) => [cid, [...bag.entries()]])
  }));
}
function deserializeCompBuckets(rows: RawState["__comp"]) {
  const m = new Map<string, CompCounts>();
  for (const r of rows) {
    const units = new Map<string, Map<string, number>>();
    for (const [cid, arr] of r.units) units.set(cid, new Map(arr));
    m.set(r.key, { patch: r.patch, comp_key: r.key.split("::")[1], picks: r.picks, wins: r.wins, sumPlacement: r.sumPlacement, units, unit_set: r.unit_set });
  }
  return m;
}
function serializeUnitCombos(map: Map<string, Map<string, {picks:number;wins:number;sumPlacement:number}>>) {
  return [...map.entries()].map(([unit, bag]) => ({
    unit,
    combos: [...bag.entries()]
  }));
}
function deserializeUnitCombos(rows: RawState["__unitCombos"]) {
  const m = new Map<string, Map<string, {picks:number;wins:number;sumPlacement:number}>>();
  for (const {unit, combos} of rows) m.set(unit, new Map(combos));
  return m;
}

async function saveOutput(payload: any) {
  await fs.mkdir(outDir, { recursive: true });
  const json = JSON.stringify(payload, null, 2);
  await fs.writeFile(outPathVersioned, json);
  await fs.writeFile(outPathCurrent, json);
}

// ----- Main -----
(async () => {
  console.log(`[Config] patch=${PATCH} platforms=${PLATFORMS} seed=${SEED_SUMMONERS} per=${MATCHES_PER}`);

  // Load previous state; if patch changed, ignore
  const prev = await loadPrevRaw();
  let compBuckets = new Map<string, CompCounts>();
  let unitComboBuckets = new Map<string, Map<string, {picks:number;wins:number;sumPlacement:number}>>();
  if (prev && prev.patch === PATCH) {
    compBuckets = deserializeCompBuckets(prev.__comp);
    unitComboBuckets = deserializeUnitCombos(prev.__unitCombos);
    console.log(`[Resume] previous buckets found for patch ${PATCH}`);
  } else if (prev) {
    console.log(`[Reset] found previous patch ${prev.patch}; starting fresh for ${PATCH}`);
  }

  // For each platform, seed IDs, get PUUIDs, pull matches, aggregate
  const platforms = PLATFORMS.split(",").map(s => s.trim()).filter(Boolean) as Platform[];
  for (const platform of platforms) {
    console.log(`[Platform] ${platform} — seeding ladder...`);
    const ids = await seedSummonerIdsForPlatform(platform);
    const cap = Number(SEED_SUMMONERS);
    const puuids = await toPuuids(platform, ids, cap);
    console.log(`[Platform] ${platform} — PUUIDs=${puuids.length}`);

    console.log(`[Platform] ${platform} — pulling matches per=${MATCHES_PER}`);
    const matches = await pullMatchesForPlatform(platform, puuids, Number(MATCHES_PER));
    console.log(`[Platform] ${platform} — matches=${matches.length}`);

    const { compBuckets: addComp, unitCombos: addCombos } =
      aggregateCountsAndCombos(matches, PATCH);

    mergeCompBuckets(compBuckets, addComp);
    mergeUnitCombos(unitComboBuckets, addCombos);
  }

  // Finalize outputs
  const comps_top20 = finalizeComps(compBuckets, Number(MIN_PICKS));
  const unit_item_meta: UnitComboRow[] = finalizeUnitCombos(unitComboBuckets, Number(MIN_PICKS_ITEM_COMBO), 10);

  // Save combined file
  const payload = {
    generated_at: new Date().toISOString(),
    patch: PATCH,
    platforms,
    ranks_included: ["DIAMOND","MASTER","GRANDMASTER","CHALLENGER"],
    seed_summoners_per_platform: Number(SEED_SUMMONERS),
    matches_per_puuid: Number(MATCHES_PER),
    thresholds: { min_picks_comp: Number(MIN_PICKS), min_picks_item_combo: Number(MIN_PICKS_ITEM_COMBO) },

    // App-facing data:
    comps_top20,       // comps ranked by avg placement (then picks)
    unit_item_meta,    // per-unit top 3-item combos, independent of comp

    // Raw state to resume next run (same patch only)
    __comp: serializeCompBuckets(compBuckets),
    __unitCombos: serializeUnitCombos(unitComboBuckets)
  };

  await saveOutput(payload);
  console.log(`[Done] wrote data/${versionedName} and data/${currentName}`);
})().catch(e => { console.error(e); process.exit(1); });
