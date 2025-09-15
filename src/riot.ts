import fetch from "node-fetch";

export type Platform =
  | "NA1" | "EUW1" | "EUN1" | "KR" | "JP1" | "BR1" | "LA1" | "LA2" | "OC1" | "TR1" | "RU";
export type Region = "AMERICAS" | "EUROPE" | "ASIA";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url: string, apiKey: string, tries = 5): Promise<any> {
  let attempt = 0;
  while (true) {
    attempt++;
    const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
    if (res.ok) return res.json();

    // Hard fails (bad key/permissions/not found) -> throw immediately
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} :: ${url} :: ${body.slice(0,300)}`);
    }

    // Retryable (429 / 5xx)
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt >= tries) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} :: ${url} :: ${body.slice(0,300)}`);
    }

    const retryAfter = Number(res.headers.get("retry-after") || "0");
    const backoff = retryAfter > 0 ? (retryAfter * 1000) : Math.min(15000, 500 * 2 ** attempt);
    await sleep(backoff + Math.floor(Math.random() * 250)); // jitter
  }
}

export function regionFor(p: Platform): Region {
  if (p === "NA1" || p === "BR1" || p === "LA1" || p === "LA2") return "AMERICAS";
  if (p === "EUW1" || p === "EUN1" || p === "TR1" || p === "RU") return "EUROPE";
  return "ASIA";
}

export async function leagueListMasterPlus(
  platform: Platform,
  tier: "CHALLENGER" | "GRANDMASTER" | "MASTER",
  apiKey: string
): Promise<Array<{ summonerId: string }>> {
  const tierPath =
    tier === "CHALLENGER" ? "challenger" : tier === "GRANDMASTER" ? "grandmaster" : "master";
  const url = `https://${platform.toLowerCase()}.api.riotgames.com/tft/league/v1/${tierPath}`;
  const data = (await fetchWithRetry(url, apiKey)) as any;
  return (data?.entries ?? []) as Array<{ summonerId: string }>;
}

export async function leagueEntriesPaged(
  platform: Platform,
  _tier: "DIAMOND",
  division: "I" | "II" | "III" | "IV",
  page: number,
  apiKey: string
): Promise<Array<{ summonerId: string }>> {
  const url = `https://${platform.toLowerCase()}.api.riotgames.com/tft/league/v1/entries/DIAMOND/${division}?page=${page}`;
  return (await fetchWithRetry(url, apiKey)) as any[];
}

export async function summonerById(
  platform: Platform,
  encryptedSummonerId: string,
  apiKey: string
): Promise<{ puuid: string }> {
  const url = `https://${platform.toLowerCase()}.api.riotgames.com/tft/summoner/v1/summoners/${encodeURIComponent(
    encryptedSummonerId
  )}`;
  return (await fetchWithRetry(url, apiKey)) as any;
}

export async function matchIdsByPuuid(
  region: Region,
  puuid: string,
  count: number,
  apiKey: string
): Promise<string[]> {
  const url = `https://${region.toLowerCase()}.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(
    puuid
  )}/ids?count=${count}`;
  return (await fetchWithRetry(url, apiKey)) as string[];
}

export async function getMatch(region: Region, matchId: string, apiKey: string): Promise<any> {
  const url = `https://${region.toLowerCase()}.api.riotgames.com/tft/match/v1/matches/${matchId}`;
  return await fetchWithRetry(url, apiKey);
}
