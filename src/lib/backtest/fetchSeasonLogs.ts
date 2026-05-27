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

interface BoxScorePlayer {
  name: string;
  team: string;
  espnId: number;
}

/** Pull a team's full 2025-26 schedule (regular season + postseason) and
 *  return every game's eventId. ESPN's schedule endpoint requires explicit
 *  `seasontype` (2 = regular, 3 = postseason); without it the response
 *  defaults to the *current* segment only, which excludes the regular
 *  season once playoffs begin. */
async function fetchTeamSchedule(teamAbbr: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const seasontype of [2, 3]) {
    const url =
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/` +
      `${teamAbbr}/schedule?season=2026&seasontype=${seasontype}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const body = (await res.json()) as { events?: Array<{ id?: string }> };
      for (const e of body.events ?? []) if (e.id) ids.add(e.id);
    } catch {
      // ignore per-segment failures — partial coverage is fine
    }
  }
  return [...ids];
}

/** Extract every athlete who appeared in a single game's box score. */
async function fetchBoxScorePlayers(eventId: string): Promise<BoxScorePlayer[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      boxscore?: {
        players?: Array<{
          team?: { abbreviation?: string };
          statistics?: Array<{
            athletes?: Array<{
              athlete?: { id?: string; displayName?: string };
              didNotPlay?: boolean;
            }>;
          }>;
        }>;
      };
    };
    const out: BoxScorePlayer[] = [];
    for (const teamBlock of body.boxscore?.players ?? []) {
      const teamAbbr = teamBlock.team?.abbreviation ?? "";
      for (const statGroup of teamBlock.statistics ?? []) {
        for (const a of statGroup.athletes ?? []) {
          const id = a.athlete?.id;
          const name = a.athlete?.displayName;
          if (!id || !name) continue;
          out.push({ name, team: teamAbbr, espnId: Number(id) });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Box-score-driven player discovery. Iterates every team's 2025-26 schedule,
 * dedupes game IDs across opponents, pulls each box score, and unions every
 * athlete who actually appeared (including waived/traded players the
 * roster-based discovery misses).
 *
 * Returns a map keyed by espnId so callers can merge with roster data
 * without name-collision ambiguity. Throttled the same way as gamelog
 * fetches: batches of 8 with a 3s inter-batch sleep.
 */
async function discoverPlayersFromBoxScores(): Promise<Map<number, RosterPlayer & { espnId: number }>> {
  console.log("[backtest] discovering games from team schedules…");
  const schedules = await Promise.all(NBA_TEAM_ABBRS.map(fetchTeamSchedule));
  const gameIds = new Set<string>();
  for (const s of schedules) for (const id of s) gameIds.add(id);
  const allGames = [...gameIds];
  console.log(`[backtest] schedule discovered ${allGames.length} unique games`);

  const players = new Map<number, RosterPlayer & { espnId: number }>();
  const batchSize = 8;
  for (let i = 0; i < allGames.length; i += batchSize) {
    const batch = allGames.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(fetchBoxScorePlayers));
    for (const list of results) {
      for (const p of list) {
        if (!players.has(p.espnId)) {
          players.set(p.espnId, { name: p.name, team: p.team, espnId: p.espnId });
        }
      }
    }
    const done = Math.min(i + batchSize, allGames.length);
    const pct = Math.round((done / allGames.length) * 100);
    if (done % 80 === 0 || done === allGames.length) {
      console.log(`[backtest] boxscores ${done}/${allGames.length} (${pct}%) · ${players.size} unique players so far`);
    }
    if (done < allGames.length) await sleep(3000);
  }
  console.log(`[backtest] box-score discovery: ${players.size} unique players across ${allGames.length} games`);
  return players;
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
  const rosterPlayers: RosterPlayer[] = rosterResults.flat();
  console.log(`[backtest] roster discovered ${rosterPlayers.length} players`);

  // Box-score discovery — catches traded/waived/G-League players who played
  // but aren't on a current roster. Merged with roster set by ESPN ID; new
  // players (not on any current roster) are appended with a sentinel team
  // "—" (real team is whichever they last played for; gamelog fetch doesn't
  // depend on team, only on the espnId via espnFindAthleteId/displayName).
  const boxScorePlayers = await discoverPlayersFromBoxScores();
  const rosterNames = new Set(rosterPlayers.map((p) => p.name.toLowerCase()));
  const extras: RosterPlayer[] = [];
  for (const bp of boxScorePlayers.values()) {
    if (!rosterNames.has(bp.name.toLowerCase())) {
      extras.push({ name: bp.name, team: bp.team || "—" });
    }
  }
  const allPlayers: RosterPlayer[] = [...rosterPlayers, ...extras];
  console.log(
    `[backtest] union: ${allPlayers.length} players ` +
      `(${rosterPlayers.length} from rosters + ${extras.length} from box scores only)`,
  );

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
