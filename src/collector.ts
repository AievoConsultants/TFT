import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import {
  Platform,
  Region,
  leagueEntriesPaged,
  leagueListMasterPlus,
  summonerById,        // MUST be TFT Summoner endpoint (from riot.ts)
  matchIdsByPuuid,
  getMatch,
} from "./riot.js";

// ===== ENV =====
const {
  RIOT_API_KEY,
  PLATFORMS = "NA1,EUW1,KR",
  SEED_SUMMONERS = "1500",
  MATCHES_PER = "20",
  // Leave PATCH blank to collect ALL patches; aggregator can filter later.
  PATCH = "",
  // Ranked Standard by default (1100). 1090 Normal, 1130 Hyper Roll, 1160 Double Up.
  QUEUE_FILTER = "1100",
  // Drop matches older than N days (0 = no age filter)
  MAX_AGE_DAYS = "14",
} = process.env as Record<string, string>;

if (!RIOT_API_KEY) {
  console.error("Missing RIOT_API_KEY");
  process.exit(1);
}

// ===== Helpers =====
function regionFor(p: Platform): Region {
  if (p === "NA1" || p === "BR1" || p === "LA1" || p === "LA2") return "AMERICAS";
  if (p === "EUW1" || p === "EUN1" || p === "TR1" || p === "RU") return "EUROPE";
  return "ASIA"; // KR, JP1, OC1
}

function normalizePatch(v: string) {
  const m = v?.match?.(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : v ?? "unknown";
}

async function seedSummonerIdsForPlatform(platform: Platform) {
  const ids: string[] = [];

  // Masters+ (full lists, no paging)
  for (const tier of ["CHALLENGER", "GRANDMASTER", "MASTER"] as const) {
    try {
      const entries = await leagueListMasterPlus(platform, tier, RIOT_API_KEY);
      console.log(`[League] ${platform} ${tier} entries=${entries.length}`);
      for (const e of entries) if (e?.summonerId) ids.push(e.summonerId);
    } catch (e: any) {
      console.warn(`[League] ${platform} ${tier} failed: ${e?.message || e}`);
    }
  }

  // Diamond I..IV (pages 1..10)
  for (const div of ["I", "II", "III", "IV"] as const) {
    for (let page = 1; page <= 10; page++) {
      try {
        const rows = await leagueEntriesPaged(platform, "DIAMOND", div, page, RIOT_API_KEY);
        console.log(`[League] ${platform} DIAMOND ${div} page=${page} rows=${rows.length}`);
        if (!rows.length) break;
        for (const e of rows) if (e?.summonerId) ids.push(e.summonerId);
      } catch (e: any) {
        console.warn(
          `[League] ${platform} DIAMOND ${div} page=${page} failed: ${e?.message || e}`
        );
        break;
      }
    }
  }

  return [...new Set(ids)];
}

async function toPuuids(platform: Platform, ids: string[], cap: number) {
  const limit = pLimit(16);
  let failures = 0;

  const out = await Promise.all(
    ids.slice(0, cap).map((id) =>
      limit(async () => {
        try {
          const s = await summonerById(platform, id, RIOT_API_KEY);
          return s?.puuid ?? null;
        } catch (e: any) {
          failures++;
          if (failures <= 10) {
            console.warn(
              `[Summoner] ${platform} id=${id} failed: ${e?.message?.slice(0, 180) || e}`
            );
          }
          return null;
        }
      })
    )
  );

  const puuids = [...new Set(out.filter(Boolean) as string[])];
  console.log(`[PUUID] ${platform} unique=${puuids.length} (failures=${failures})`);
  return puuids;
}

// What we persist per participant (NDJSON line)
type Slice = {
  match_id: string;
  platform: Platform;
  region: Region;
  patch: string; // e.g., "15.4"
  placement: number;
  units: Array<{ character_id: string; items: Array<number | string> }>;
};

function withinAge(info: any, maxDays: number): boolean {
  if (!maxDays || maxDays <= 0) return true;
  let t: number | undefined = info?.game_datetime ?? info?.gameDateTime;
  if (typeof t !== "number") return true; // can't tell; keep it
  if (t < 1e12) t = t * 1000; // seconds → ms
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
  return ageDays <= maxDays;
}

// ===== Main =====
async function run() {
  const platforms = PLATFORMS.split(",").map((s) => s.trim()).filter(Boolean) as Platform[];
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const patchDir = PATCH ? PATCH : "all";
  const outDir = path.join("data", "staging", patchDir);
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `participants-${today}.ndjson`);

  // dedupe across runs
  const stateDir = path.join("data", "state");
  await fs.mkdir(stateDir, { recursive: true });
  const seenPath = path.join(stateDir, "seen_match_ids.json");

  let seen = new Set<string>();
  try {
    seen = new Set(JSON.parse(await fs.readFile(seenPath, "utf8")));
  } catch {
    // first run is fine
  }

  let totalAppended = 0;
  const queueFilterNum = QUEUE_FILTER ? Number(QUEUE_FILTER) : 0;
  const maxAgeDaysNum = Number(MAX_AGE_DAYS) || 0;

  for (const platform of platforms) {
    const region = regionFor(platform);
    console.log(`[Platform] ${platform} seeding…`);

    const ids = await seedSummonerIdsForPlatform(platform);
    const puuids = await toPuuids(platform, ids, Number(SEED_SUMMONERS));
    console.log(`[PUUID] ${platform} unique=${puuids.length}`);

    const limitIds = pLimit(16);
    const matchIds = new Set<string>();
    await Promise.all(
      puuids.map((puuid) =>
        limitIds(async () => {
          try {
            const arr = await matchIdsByPuuid(region, puuid, Number(MATCHES_PER), RIOT_API_KEY);
            for (const id of arr) matchIds.add(id);
          } catch {
            // ignore single puuid failures
          }
        })
      )
    );
    console.log(`[MatchIDs] ${platform} total=${matchIds.size}`);

    const limitMatch = pLimit(8);
    const lines: string[] = [];

    await Promise.all(
      [...matchIds].map((mid) =>
        limitMatch(async () => {
          if (seen.has(mid)) return;

          try {
            const m = await getMatch(region, mid, RIOT_API_KEY);

            const queue = m?.info?.queue_id ?? m?.info?.queueId;
            if (queueFilterNum && Number(queue) !== queueFilterNum) return; // ranked-only default

            const patch = normalizePatch(m?.info?.game_version);
            if (PATCH && patch !== PATCH) return; // optional collector-time patch filter

            if (!withinAge(m?.info, maxAgeDaysNum)) return; // recency filter

            for (const p of m?.info?.participants || []) {
              const units = (p.units || []).map((u: any) => ({
                character_id: u.character_id,
                items: Array.isArray(u.items)
                  ? u.items
                  : Array.isArray(u.itemNames)
                  ? u.itemNames
                  : [],
              }));
              const slice: Slice = {
                match_id: mid,
                platform,
                region,
                patch,
                placement: p.placement ?? 9,
                units,
              };
              lines.push(JSON.stringify(slice));
            }

            seen.add(mid);
          } catch {
            // ignore single match failures; continue
          }
        })
      )
    );

    if (lines.length) {
      await fs.appendFile(outFile, lines.join("\n") + "\n", "utf8");
      console.log(`[Write] ${platform} appended ${lines.length} slices to ${outFile}`);
      totalAppended += lines.length;
    } else {
      console.log(`[Write] ${platform} appended 0 slices`);
    }
  }

  const keep = Array.from(seen).slice(-500000); // cap state size
  await fs.writeFile(seenPath, JSON.stringify(keep));

  console.log(`[Collector] wrote total ${totalAppended} slices → ${outFile}`);
  if (totalAppended === 0) {
    console.warn("[Collector] 0 slices appended — likely queue/patch/age filters too strict or PUUID step failing.");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
