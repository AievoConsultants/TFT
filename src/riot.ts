import fetch from "node-fetch";

// ----- Types you can import elsewhere -----
export type Platform =
  | "NA1" | "EUW1" | "EUN1" | "KR" | "JP1" | "BR1" | "LA1" | "LA2" | "OC1" | "TR1" | "RU";
export type Region = "AMERICAS" | "EUROPE" | "ASIA";

async function fetchJSON(url: string, apiKey: string) {
  const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} :: ${url} :: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ---- League lists (Masters+) ----
export async function leagueListMasterPlus(
  platform: Platform,
  tier: "CHALLENGER" | "GRANDMASTER" | "MASTER",
  apiKey: string
): Promise<Array<{ summonerId: string }>> {
  const tierPath =
    tier === "CHALLENGER" ? "challenger" : tier === "GRANDMASTER" ? "grandmaster" : "master";
  const url = `https://${platform.toLowerCase()}.api.riotgames.com/tft/league/v1/${tierPath}`;
  const data = (await fetchJSON(url, apiKey)) as any;
  return (data?.entries ?? []) as Array<{ summonerId: string }>;
}

// ---- Diamond paged entries ----
export async function leagueEntriesPaged(
  platform: Platform,
  tier: "DIAMOND",
  division: "I" | "II" | "III" | "IV",
  page: number,
  apiKey: string
): Promise<Array<{ summonerId: string }>> {
  const url = `https://${platform.toLowerCase()}.api.riotgames.com/tft/league/v1/entries/${tier}/${division}?page=${page}`;
  return (await fetchJSON(url, apiKey)) as any[];
}

// ---- *TFT* Summoner by encryptedSummonerId -> includes puuid ----
export async function summonerById(
  platform: Platform,
  encryptedSummonerId: string,
  apiKey: string
): Promise<{ puuid: string }> {
  const url = `https://${platform.toLowerCase()}.api.riotgames.com/tft/summoner/v1/summoners/${encodeURIComponent(
    encryptedSummonerId
  )}`;
  return (await fetchJSON(url, apiKey)) as any;
}

// ---- Match IDs by PUUID ----
export async function matchIdsByPuuid(
  region: Region,
  puuid: string,
  count: number,
  apiKey: string
): Promise<string[]> {
  const url = `https://${region.toLowerCase()}.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(
    puuid
  )}/ids?count=${count}`;
  return (await fetchJSON(url, apiKey)) as string[];
}

// ---- Single Match ----
export async function getMatch(region: Region, matchId: string, apiKey: string): Promise<any> {
  const url = `https://${region.toLowerCase()}.api.riotgames.com/tft/match/v1/matches/${matchId}`;
  return await fetchJSON(url, apiKey);
}
