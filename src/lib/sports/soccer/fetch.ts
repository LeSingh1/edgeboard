// src/lib/sports/soccer/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const COMPETITIONS = ["eng.1", "usa.1", "mex.1", "uefa.champions", "uefa.europa"];

// In-memory cache built during fetchPlayerRoster, consumed by fetchPlayerGamelog.
const gamelogCache = new Map<string, RawGame[]>();

export async function fetchTeamSchedule(teamSlug: string, season: number): Promise<string[]> {
  const [competition, team] = teamSlug.includes("/") ? teamSlug.split("/") : [COMPETITIONS[0], teamSlug];
  const ids = new Set<string>();
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${competition}/teams/${team}/schedule?season=${season}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { events?: Array<{ id?: string }> };
    for (const e of body.events ?? []) if (e.id) ids.add(e.id);
  } catch { /* skip */ }
  return [...ids];
}

async function fetchTeamsInCompetition(competition: string): Promise<string[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${competition}/teams`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: { id?: string } }> }> }> };
    const out: string[] = [];
    for (const sport of body.sports ?? []) {
      for (const lg of sport.leagues ?? []) {
        for (const t of lg.teams ?? []) {
          if (t.team?.id) out.push(t.team.id);
        }
      }
    }
    return out;
  } catch { return []; }
}

interface SummaryPlayerStat {
  name: string;
  abbreviation: string;
  value: number;
  displayValue: string;
}

interface SummaryRoster {
  team?: { abbreviation?: string };
  roster?: Array<{
    athlete?: { id?: string; displayName?: string };
    position?: { abbreviation?: string; displayName?: string };
    stats?: SummaryPlayerStat[];
  }>;
}

async function fetchEventPlayerStats(
  competition: string,
  eventId: string,
  gameDate: string,
): Promise<{ players: PlayerRef[]; games: Map<string, RawGame> }> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${competition}/summary?event=${eventId}`;
  const players: PlayerRef[] = [];
  const games = new Map<string, RawGame>();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return { players, games };
    const body = await res.json() as { rosters?: SummaryRoster[] };
    for (const tm of body.rosters ?? []) {
      for (const r of tm.roster ?? []) {
        const id = r.athlete?.id;
        const name = r.athlete?.displayName;
        if (!id || !name) continue;
        players.push({ id, name, team: tm.team?.abbreviation });

        const posAbbr = r.position?.abbreviation ?? "";
        const isGoalie = posAbbr === "G" || posAbbr === "GK";
        const statsObj: Record<string, number | string | null> = {
          type: isGoalie ? "goalkeeper" : "field",
        };
        for (const s of r.stats ?? []) {
          statsObj[s.abbreviation] = s.value;
        }
        games.set(id, {
          eventId,
          gameDate,
          stats: statsObj,
          isPlayoff: false,
        });
      }
    }
  } catch { /* skip */ }
  return { players, games };
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  gamelogCache.clear();
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();

  // Bounded aggressively: caps kept finite because every event is two
  // sequential ESPN calls — fully uncapping invites rate-limiting.
  for (const season of [y, y - 1, y - 2]) {
    for (const competition of COMPETITIONS) {
      const teams = await fetchTeamsInCompetition(competition);
      for (const team of teams.slice(0, 25)) {
        const eventIds = await fetchTeamSchedule(`${competition}/${team}`, season);
        for (const eventId of eventIds.slice(0, 20)) {
          // Fetch game date from event header
          let gameDate = "";
          try {
            const schedUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${competition}/scoreboard/${eventId}`;
            const sRes = await fetch(schedUrl, { headers: { "User-Agent": UA } });
            if (sRes.ok) {
              const sData = await sRes.json() as { competitions?: Array<{ date?: string }> };
              gameDate = sData.competitions?.[0]?.date ?? "";
            }
          } catch { /* skip */ }

          const { players, games } = await fetchEventPlayerStats(competition, eventId, gameDate);
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
    if (seen.size > 1000) break;
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, _seasons: number[]): Promise<RawGame[]> {
  return gamelogCache.get(playerId) ?? [];
}
