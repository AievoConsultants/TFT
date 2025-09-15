import fetch from "node-fetch";

export type Region = "AMERICAS" | "EUROPE" | "ASIA";
export type Platform =
  | "NA1" | "EUW1" | "EUN1" | "KR" | "BR1" | "LA1" | "LA2"
  | "OC1" | "TR1" | "RU"  | "JP1";

const BASE_MATCH = (region: Region) => `https://${region}.api.riotgames.com`;
const BASE_PLATFORM = (platform: Platform) => `https://${platform}.api.riotgames.com`;
const ok = async (r: any) => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`); return r; };

// ---------- LEAGUE (ladder) ----------

// Non-master tiers (need page + division)
export async function leagueEntriesPaged(
  platform: Platform,
  tier: "DIAMOND" | "EMERALD" | "PLATINUM" | "GOLD" | "SILVER" | "BRONZE" | "IRON",
  division: "I" | "II" | "III" | "IV",
  page: number,
  key: string
) {
  const url = `${BASE_PLATFORM(platform)}/tft/league/v1/entries/${tier}/${division}?page=${page}`;
  const r = await fetch(url, { headers: { "X-Riot-Token": key } }).then(ok);
  return r.json() as Promise<Array<{ summonerId: string }>>;
}

// Master / Grandmaster / Challenger (full list, no paging)
export async function leagueListMasterPlus(
  platform: Platform,
  tier: "CHALLENGER" | "GRANDMASTER" | "MASTER",
  key: string
) {
  const path = tier.toLowerCase(); // challenger|grandmaster|master
  const url = `${BASE_PLATFORM(platform)}/tft/league/v1/${path}`;
  const r = await fetch(url, { headers: { "X-Riot-Token": key } }).then(ok);
  const data = (await r.json()) as { entries?: Array<{ summonerId: string }> };
  return data.entries ?? [];
}

// ---------- SUMMONER → PUUID ----------
export async function summonerById(platform: Platform, summonerId: string, key: string) {
  const url = `${BASE_PLATFORM(platform)}/tft/summoner/v1/summoners/${encodeURIComponent(summonerId)}`;
  const r = await fetch(url, { headers: { "X-Riot-Token": key } }).then(ok);
  return r.json() as Promise<{ puuid: string }>;
}

// ---------- MATCH ----------
export async function matchIdsByPuuid(region: Region, puuid: string, count: number, key: string) {
  const url = `${BASE_MATCH(region)}/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=0&count=${count}`;
  const r = await fetch(url, { headers: { "X-Riot-Token": key } }).then(ok);
  return r.json() as Promise<string[]>;
}

export async function getMatch(region: Region, matchId: string, key: string) {
  const url = `${BASE_MATCH(region)}/tft/match/v1/matches/${encodeURIComponent(matchId)}`;
  const r = await fetch(url, { headers: { "X-Riot-Token": key } }).then(ok);
  return r.json() as Promise<any>;
}
