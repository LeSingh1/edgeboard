/**
 * NBA playoff roster fetcher.
 *
 * Discovers which teams are still alive in the current postseason by reading
 * ESPN's scoreboard for the trailing 10 days (any team that played a
 * `season.type === 3` game recently is still alive — eliminated teams stop
 * appearing). For each alive team, pulls the active roster.
 *
 * Used by the playoff-warmup job to pre-fetch gamelogs + news for every
 * player on a contending team, and by the Auto-Pilot "playoffs only"
 * filter to scope the optimizer pool.
 *
 * Free, no auth — ESPN's site API doesn't require a key for these.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

export interface PlayoffPlayer {
  /** ESPN's numeric athlete ID — drives news fetches. */
  espnId: number;
  /** Display name as it shows on ESPN. */
  name: string;
  /** Team abbreviation (e.g. "CLE"). */
  team: string;
  /** Position abbreviation (G/F/C/G-F/F-C). */
  position?: string;
  /** Jersey number, if present. */
  jersey?: string;
}

export interface PlayoffRoster {
  /** Sorted list of team abbreviations still alive in the playoffs. */
  teams: string[];
  /** Every player on every alive team's active roster. */
  players: PlayoffPlayer[];
  /** ISO timestamp the roster was fetched. */
  fetchedAt: string;
}

/**
 * Returns the set of team abbreviations that played a postseason game in
 * the given trailing window. Teams that have been eliminated drop out of
 * the scoreboard a few days after their last loss.
 *
 * Default window: 10 days back from today. That's wide enough to catch
 * any team in an active series (max gap between games is ~3 days) but
 * tight enough to drop teams swept out of a prior round.
 */
export async function fetchAlivePlayoffTeams(opts: { daysBack?: number } = {}): Promise<string[]> {
  const daysBack = opts.daysBack ?? 10;
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${fmt(start)}-${fmt(end)}&limit=100`;

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    next: { revalidate: 600 }, // 10-min cache
  });
  if (!res.ok) throw new Error(`ESPN scoreboard returned ${res.status}`);
  const body = (await res.json()) as {
    events?: Array<{
      season?: { type?: number };
      competitions?: Array<{
        competitors?: Array<{ team?: { abbreviation?: string } }>;
      }>;
    }>;
  };

  const teams = new Set<string>();
  for (const ev of body.events ?? []) {
    // season.type === 3 means postseason. We only want playoff games, not
    // play-in or pre-season carryover.
    if (ev.season?.type !== 3) continue;
    for (const comp of ev.competitions ?? []) {
      for (const t of comp.competitors ?? []) {
        const ab = t.team?.abbreviation;
        if (ab) teams.add(ab);
      }
    }
  }
  return [...teams].sort();
}

/** Fetch the active roster for one team via ESPN. */
export async function fetchTeamRoster(teamAbbr: string): Promise<PlayoffPlayer[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamAbbr}/roster`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    next: { revalidate: 3600 }, // 1-hour cache — rosters change rarely
  });
  if (!res.ok) throw new Error(`ESPN roster for ${teamAbbr} returned ${res.status}`);
  const body = (await res.json()) as {
    athletes?: Array<{
      id?: string | number;
      displayName?: string;
      jersey?: string;
      position?: { abbreviation?: string };
    }>;
  };

  const out: PlayoffPlayer[] = [];
  for (const a of body.athletes ?? []) {
    const id = typeof a.id === "string" ? Number(a.id) : a.id;
    if (!id || !a.displayName) continue;
    out.push({
      espnId: id,
      name: a.displayName,
      team: teamAbbr,
      position: a.position?.abbreviation,
      jersey: a.jersey,
    });
  }
  return out;
}

/**
 * Top-level helper — alive teams + every player on each. One trip from
 * "who's left?" to "the names + IDs we need to warm up."
 */
export async function fetchPlayoffRoster(): Promise<PlayoffRoster> {
  const teams = await fetchAlivePlayoffTeams();
  // Parallel roster fetches — 4-16 calls, all of them are cached on ESPN's
  // edge, so this is fast.
  const rosters = await Promise.all(teams.map((t) => fetchTeamRoster(t).catch(() => [] as PlayoffPlayer[])));
  const players: PlayoffPlayer[] = [];
  for (const r of rosters) players.push(...r);
  return {
    teams,
    players,
    fetchedAt: new Date().toISOString(),
  };
}
