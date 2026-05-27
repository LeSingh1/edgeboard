// src/lib/sports/ncaaf/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// AP top-25 + a few additional powerhouses. ESPN team numeric IDs (slugs
// like "ohio-st", "fla-st", "kansas-st", "nc-st", "virg-tech", "tex-am",
// "mizzou", "ind" all 400 on the schedule endpoint — IDs are stable).
const NCAAF_TEAMS = [
  "61",   // Georgia
  "251",  // Texas
  "194",  // Ohio State
  "333",  // Alabama
  "2483", // Oregon
  "130",  // Michigan
  "213",  // Penn State
  "245",  // Texas A&M
  "142",  // Missouri
  "145",  // Ole Miss
  "2633", // Tennessee
  "52",   // Florida State
  "228",  // Clemson
  "99",   // LSU
  "201",  // Oklahoma
  "87",   // Notre Dame
  "254",  // Utah
  "30",   // USC
  "264",  // Washington
  "275",  // Wisconsin
  "2294", // Iowa
  "84",   // Indiana
  "2306", // Kansas State
  "152",  // NC State
  "259",  // Virginia Tech
  "2",    // Auburn
  "235",  // Memphis
  "96",   // Kentucky
  "239",  // Baylor
  "2628", // TCU
];

export async function fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]> {
  const ids = new Set<string>();
  for (const seasontype of [2, 3]) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${teamAbbr}/schedule?season=${season}&seasontype=${seasontype}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const body = await res.json() as { events?: Array<{ id?: string }> };
      for (const e of body.events ?? []) if (e.id) ids.add(e.id);
    } catch { /* skip */ }
  }
  return [...ids];
}

async function fetchBoxScorePlayers(eventId: string): Promise<PlayerRef[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=${eventId}`;
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
  // Try current year first; if no usable boxscores (off-season), fall back to
  // year-1. ESPN returns events for future seasons without populated boxscores.
  for (const season of [y, y - 1]) {
    for (const team of NCAAF_TEAMS) {
      const events = await fetchTeamSchedule(team, season);
      for (const eventId of events.slice(0, 2)) {
        for (const p of await fetchBoxScorePlayers(eventId)) {
          if (!seen.has(p.id)) seen.set(p.id, p);
        }
      }
    }
    if (seen.size > 50) break;  // got enough — stop walking back
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/${playerId}/gamelog?season=${season}`;
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
