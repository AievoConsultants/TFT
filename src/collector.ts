// src/collector.ts
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import {
  Platform, Region, regionFor,
  leagueEntriesPaged, leagueListMasterPlus, summonerById,
  matchIdsByPuuid, getMatch
} from "./riot.js";

// === Minimal env (key + optional knobs) ===
const {
  RIOT_API_KEY,
  PLATFORMS = "NA1,EUW1,KR",
  SEED_SUMMONERS = "1500",     // width: how many Diamond+ accounts per platform to sample
  MAX_AGE_DAYS = "7"           // recency window (days). "most current" default = 7
} = process.env as Record<string,string>;

if (!RIOT_API_KEY) { console.error("Missing RIOT_API_KEY"); process.exit(1); }

// === Hard filters per your request ===
const RANKED_QUEUE = 1100;     // TFT Ranked (Standard) only
const MATCHES_PER = 20;        // recent matches per PUUID (depth). keep fixed.

function normalizePatch(v: string) {
  const m = v?.match?.(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : v ?? "unknown";
}
function withinAge(info: any, maxDays: number): boolean {
  const d = Number(maxDays) || 0;
  if (!d) return true;
  let t: number | undefined = info?.game_datetime ?? info?.gameDateTime;
  if (typeof t !== "number") return true;
  if (t < 1e12) t *= 1000;
  return (Date.now() - t) / 86400000 <= d;
}

// --- seed Diamond+ accounts (Challenger/GM/Master lists + Diamond pages) ---
async function seedSummonerIdsForPlatform(platform: Platform) {
  const ids: string[] = [];
  for (const tier of ["CHALLENGER","GRANDMASTER","MASTER"] as const) {
    try {
      const entries = await leagueListMasterPlus(platform, tier, RIOT_API_KEY);
      console.log(`[League] ${platform} ${tier} entries=${entries.length}`);
      for (const e of entries) e?.summonerId && ids.push(e.summonerId);
    } catch (e:any) { console.warn(`[League] ${platform} ${tier} failed: ${e?.message||e}`); }
  }
  for (const div of ["I","II","III","IV"] as const) {
    for (let page=1; page<=10; page++) {
      try {
        const rows = await leagueEntriesPaged(platform, "DIAMOND", div, page, RIOT_API_KEY);
        console.log(`[League] ${platform} DIAMOND ${div} page=${page} rows=${rows.length}`);
        if (!rows.length) break;
        for (const e of rows) e?.summonerId && ids.push(e.summonerId);
      } catch (e:any) { console.warn(`[League] ${platform} DIAMOND ${div} page=${page} failed: ${e?.message||e}`); break; }
    }
  }
  return [...new Set(ids)];
}

async function toPuuids(platform: Platform, ids: string[], cap: number) {
  const limit = pLimit(8);
  let failures = 0;
  const out = await Promise.all(ids.slice(0, cap).map(id =>
    limit(async () => {
      try { return (await summonerById(platform, id, RIOT_API_KEY))?.puuid ?? null; }
      catch (e:any) { if (++failures <= 8) console.warn(`[Summoner] ${platform} ${id} failed: ${e?.message||e}`); return null; }
    })
  ));
  const puuids = [...new Set(out.filter(Boolean) as string[])];
  console.log(`[PUUID] ${platform} unique=${puuids.length} (failures=${failures})`);
  return puuids;
}

type Slice = {
  match_id: string;
  platform: Platform;
  region: Region;
  patch: string;
  placement: number;
  units: Array<{ character_id: string; items: Array<number|string> }>;
};

async function run() {
  const platforms = PLATFORMS.split(",").map(s=>s.trim()).filter(Boolean) as Platform[];
  const today = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const outDir = path.join("data","staging","all"); // always write to ALL (no patch filter here)
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `participants-${today}.ndjson`);

  const stateDir = path.join("data","state");
  await fs.mkdir(stateDir, { recursive: true });
  const seenPath = path.join(stateDir, "seen_match_ids.json");

  let seen = new Set<string>();
  try { seen = new Set(JSON.parse(await fs.readFile(seenPath,"utf8"))); } catch {}

  let totalAppended = 0;
  const maxAgeDaysNum = Number(MAX_AGE_DAYS) || 0;

  for (const platform of platforms) {
    const region = regionFor(platform);
    console.log(`[Platform] ${platform} seeding…`);
    const ids = await seedSummonerIdsForPlatform(platform);
    const puuids = await toPuuids(platform, ids, Number(SEED_SUMMONERS));
    if (!puuids.length) { console.warn(`[PUUID] ${platform} none resolved`); continue; }

    const limitIds = pLimit(8);
    const matchIds = new Set<string>();
    await Promise.all(puuids.map(puuid =>
      limitIds(async () => {
        try {
          const arr = await matchIdsByPuuid(region, puuid, MATCHES_PER, RIOT_API_KEY);
          for (const id of arr) matchIds.add(id);
        } catch {}
      })
    ));
    console.log(`[MatchIDs] ${platform} total=${matchIds.size}`);
    if (!matchIds.size) continue;

    const limitMatch = pLimit(4);
    const lines: string[] = [];
    let dropQueue=0, dropAge=0, dropEmpty=0;

    await Promise.all([...matchIds].map(mid =>
      limitMatch(async () => {
        if (seen.has(mid)) return;
        try {
          const m = await getMatch(region, mid, RIOT_API_KEY);

          const queue = m?.info?.queue_id ?? m?.info?.queueId;
          if (Number(queue) !== RANKED_QUEUE) { dropQueue++; return; } // RANKED ONLY

          if (!withinAge(m?.info, maxAgeDaysNum)) { dropAge++; return; } // RECENT ONLY

          const patch = normalizePatch(m?.info?.game_version);
          const parts = m?.info?.participants || [];
          if (!parts.length) { dropEmpty++; return; }

          for (const p of parts) {
            const units = (p.units || []).map((u:any)=>({
              character_id: u.character_id,
              items: Array.isArray(u.items) ? u.items : (Array.isArray(u.itemNames) ? u.itemNames : [])
            }));
            lines.push(JSON.stringify({
              match_id: mid, platform, region, patch,
              placement: p.placement ?? 9, units
            }));
          }
          seen.add(mid);
        } catch {}
      })
    ));

    console.log(`[Filters] dropQueue=${dropQueue} dropAge=${dropAge} dropEmpty=${dropEmpty}`);
    if (lines.length) {
      await fs.appendFile(outFile, lines.join("\n") + "\n", "utf8");
      console.log(`[Write] ${platform} appended ${lines.length} slices to ${outFile}`);
      totalAppended += lines.length;
    } else {
      console.log(`[Write] ${platform} appended 0 slices`);
    }
  }

  const keep = Array.from(seen).slice(-500000);
  await fs.writeFile(seenPath, JSON.stringify(keep));
  console.log(`[Collector] wrote total ${totalAppended} slices → ${outFile}`);
  if (totalAppended === 0) console.warn("[Collector] 0 slices appended — check PUUID/filters logs above.");
}

run().catch(e => { console.error(e); process.exit(1); });
