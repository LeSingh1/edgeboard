import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AFL_TEAMS = [
  "15", "11", "9", "17", "16", "1", "8", "14", "10", "13",
  "2", "5", "7", "12", "18", "4", "3", "6",
];

// In-memory cache built during fetchPlayerRoster, consumed by fetchPlayerGamelog.
const gamelogCache = new Map<string, RawGame[]>();

export async function fetchTeamSchedule(teamId: string, season: number): Promise<string[]> {
  const ids = new Set<string>();
  const url = `https://site.api.espn.com/apis/site/v2/sports/australian-football/afl/teams/${teamId}/schedule?season=${season}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { events?: Array<{ id?: string }> };
    for (const e of body.events ?? []) if (e.id) ids.add(e.id);
  } catch { /* skip */ }
  return [...ids];
}

interface BoxscorePlayer {
  team?: { abbreviation?: string };
  statistics?: Array<{
    labels?: string[];
    athletes?: Array<{
      athlete?: { id?: string; displayName?: string };
      stats?: string[];
    }>;
  }>;
}

async function fetchEventPlayerStats(eventId: string): Promise<{ players: PlayerRef[]; games: Map<string, RawGame> }> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/australian-football/afl/summary?event=${eventId}`;
  const players: PlayerRef[] = [];
  const games = new Map<string, RawGame>();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return { players, games };
    const body = await res.json() as {
      boxscore?: { players?: BoxscorePlayer[] };
      header?: { competitions?: Array<{ date?: string }> };
    };
    const gameDate = body.header?.competitions?.[0]?.date ?? "";
    for (const team of body.boxscore?.players ?? []) {
      for (const statGroup of team.statistics ?? []) {
        const labels = statGroup.labels ?? [];
        for (const a of statGroup.athletes ?? []) {
          const id = a.athlete?.id;
          const name = a.athlete?.displayName;
          if (!id || !name) continue;
          players.push({ id, name, team: team.team?.abbreviation });

          const statsObj: Record<string, number | string | null> = {};
          for (let i = 0; i < labels.length; i++) {
            const v = a.stats?.[i];
            if (v == null) continue;
            const n = parseFloat(v);
            statsObj[labels[i]] = Number.isFinite(n) ? n : v;
          }
          games.set(id, { eventId, gameDate, stats: statsObj, isPlayoff: false });
        }
      }
    }
  } catch { /* skip */ }
  return { players, games };
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  gamelogCache.clear();
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();

  for (const season of [y, y - 1, y - 2, y - 3]) {
    for (const team of AFL_TEAMS) {
      const events = await fetchTeamSchedule(team, season);
      for (const eventId of events.slice(0, 30)) {
        const { players, games } = await fetchEventPlayerStats(eventId);
        for (const p of players) {
          if (!seen.has(p.id)) seen.set(p.id, p);
          const existing = gamelogCache.get(p.id) ?? [];
          const game = games.get(p.id);
          if (game) {
            existing.push(game);
            gamelogCache.set(p.id, existing);
          }
        }
      }
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, _seasons: number[]): Promise<RawGame[]> {
  return gamelogCache.get(playerId) ?? [];
}
