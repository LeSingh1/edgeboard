import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AFL_TEAMS = ["adel","bl","carl","coll","ess","fre","geel","gcfc","gws","haw","melb","nm","port","rich","stk","syd","wb","wce"];

export async function fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]> {
  const ids = new Set<string>();
  const url = `https://site.api.espn.com/apis/site/v2/sports/aussierules/afl/teams/${teamAbbr}/schedule?season=${season}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { events?: Array<{ id?: string }> };
    for (const e of body.events ?? []) if (e.id) ids.add(e.id);
  } catch { /* skip */ }
  return [...ids];
}

async function fetchBoxScorePlayers(eventId: string): Promise<PlayerRef[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/aussierules/afl/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { boxscore?: { players?: Array<{ team?: { abbreviation?: string }; statistics?: Array<{ athletes?: Array<{ athlete?: { id?: string; displayName?: string } }> }> }> } };
    const out: PlayerRef[] = [];
    for (const team of body.boxscore?.players ?? []) {
      for (const stat of team.statistics ?? []) {
        for (const a of stat.athletes ?? []) {
          if (a.athlete?.id && a.athlete?.displayName) {
            out.push({ id: a.athlete.id, name: a.athlete.displayName, team: team.team?.abbreviation });
          }
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();
  for (const team of AFL_TEAMS) {
    const events = await fetchTeamSchedule(team, y);
    for (const eventId of events.slice(0, 2)) {
      for (const p of await fetchBoxScorePlayers(eventId)) {
        if (!seen.has(p.id)) seen.set(p.id, p);
      }
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/aussierules/afl/athletes/${playerId}/gamelog?season=${season}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const data = await res.json() as { labels?: string[]; seasonTypes?: Array<{ categories?: Array<{ events?: Array<{ eventId: string; stats: string[] }> }> }>; events?: Record<string, { gameDate?: string; atVs?: "@" | "vs"; opponent?: { abbreviation?: string } }> };
      const labels = data.labels ?? [];
      for (const st of data.seasonTypes ?? []) {
        for (const cat of st.categories ?? []) {
          for (const evt of cat.events ?? []) {
            const statsObj: Record<string, number | string | null> = {};
            for (let i = 0; i < labels.length; i++) {
              const v = evt.stats[i]; const n = parseFloat(v); statsObj[labels[i]] = Number.isFinite(n) ? n : v;
            }
            const meta = data.events?.[evt.eventId];
            out.push({ eventId: evt.eventId, gameDate: meta?.gameDate ?? "", stats: statsObj,
              opponentAbbr: meta?.opponent?.abbreviation, atVs: meta?.atVs, isPlayoff: false });
          }
        }
      }
    } catch { /* skip */ }
  }
  return out;
}
