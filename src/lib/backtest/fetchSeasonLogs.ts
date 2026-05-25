/**
 * Backtest data fetcher — pulls 2025-26 season gamelogs for every NBA
 * player from ESPN, caches the result to disk.
 *
 * Idempotent: if `data/backtest/gamelogs.json` exists and is < 24h old,
 * we skip the network entirely. Pass `force: true` to override.
 *
 * Concurrency is throttled (batches of 8 with a 3s sleep) — ESPN starts
 * returning 429s past ~10 req/sec from a single IP.
 *
 * Output shape: { players: PlayerGamelog[], fetchedAt }
 * where PlayerGamelog carries the same labels/events/meta we use live,
 * so the rest of the pipeline can reuse the existing extractors verbatim.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  espnFindAthleteId,
  espnGameLog,
  type EspnGamelogEvent,
  type EspnEventMeta,
} from "@/lib/realProjections";

const CACHE_PATH = path.join(process.cwd(), "data", "backtest", "gamelogs.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface PlayerGamelog {
  name: string;
  team: string;
  espnId: number;
  labels: string[];
  events: EspnGamelogEvent[];
  /** Serialized as an array of [eventId, meta] pairs because Map → JSON
   *  doesn't survive round-tripping. Reassembled on read. */
  metaPairs: Array<[string, EspnEventMeta]>;
}

export interface SeasonLogsCache {
  fetchedAt: string;
  players: PlayerGamelog[];
}

/** ESPN team-by-team roster fetcher — same endpoint we use in playoffRoster.
 *  Returns ALL 30 NBA teams (not just playoff-alive). */
const NBA_TEAM_ABBRS = [
  "ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GS",
  "HOU", "IND", "LAC", "LAL", "MEM", "MIA", "MIL", "MIN", "NO", "NY",
  "OKC", "ORL", "PHI", "PHX", "POR", "SAC", "SA", "TOR", "UTAH", "WSH",
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface RosterPlayer {
  name: string;
  team: string;
}

async function fetchRoster(teamAbbr: string): Promise<RosterPlayer[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamAbbr}/roster`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      athletes?: Array<{ displayName?: string }>;
    };
    return (body.athletes ?? [])
      .filter((a) => a.displayName)
      .map((a) => ({ name: a.displayName!, team: teamAbbr }));
  } catch {
    return [];
  }
}

/** Read the cache if it exists and is fresh. */
async function readCache(): Promise<SeasonLogsCache | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as SeasonLogsCache;
    const ageMs = Date.now() - new Date(parsed.fetchedAt).getTime();
    if (ageMs < CACHE_TTL_MS) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cache: SeasonLogsCache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** Sleep helper for the inter-batch throttle. */
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Pull every NBA player's gamelog. Concurrency: batches of 8 per team's
 * roster, 3s pause between batches. Per-player failures (ESPN 5xx,
 * unknown athlete) are silently skipped so a partial dataset still
 * makes it to disk.
 *
 * Roughly ~450 players × ~1.2s per fetch (with throttle) ≈ 5-8 min wall
 * time the first time. Cache hits subsequent runs are instant.
 */
export async function fetchSeasonLogs(opts: { force?: boolean } = {}): Promise<SeasonLogsCache> {
  if (!opts.force) {
    const cached = await readCache();
    if (cached) {
      console.log(`[backtest] cache hit: ${cached.players.length} players from ${cached.fetchedAt}`);
      return cached;
    }
  }

  console.log("[backtest] fetching rosters for all 30 NBA teams…");
  const rosterResults = await Promise.all(NBA_TEAM_ABBRS.map(fetchRoster));
  const allPlayers: RosterPlayer[] = rosterResults.flat();
  console.log(`[backtest] roster discovered ${allPlayers.length} players`);

  const out: PlayerGamelog[] = [];
  const batchSize = 8;
  for (let i = 0; i < allPlayers.length; i += batchSize) {
    const batch = allPlayers.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          const id = await espnFindAthleteId(p.name, "nba");
          if (!id) return null;
          const { labels, events, meta } = await espnGameLog(id, "nba");
          if (events.length === 0) return null;
          return {
            name: p.name,
            team: p.team,
            espnId: id,
            labels,
            events,
            metaPairs: Array.from(meta.entries()),
          } satisfies PlayerGamelog;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) out.push(r);
    const pct = Math.round(((i + batchSize) / allPlayers.length) * 100);
    console.log(`[backtest] gamelogs ${Math.min(i + batchSize, allPlayers.length)}/${allPlayers.length} (${pct}%)`);
    if (i + batchSize < allPlayers.length) {
      await sleep(3000); // throttle — ESPN starts 429ing past ~10 rps
    }
  }

  const cache: SeasonLogsCache = {
    fetchedAt: new Date().toISOString(),
    players: out,
  };
  await writeCache(cache);
  console.log(`[backtest] cached ${out.length} player gamelogs to ${CACHE_PATH}`);
  return cache;
}
