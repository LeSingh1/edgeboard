// src/lib/sports/soccer/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const COMPETITIONS = ["eng.1", "usa.1", "mex.1", "uefa.champions", "uefa.europa"];

export async function fetchTeamSchedule(teamSlug: string, season: number): Promise<string[]> {
  // teamSlug is a "competition/team" composite. For training we pull schedules per competition.
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
    const body = await res.json() as { sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: { id?: string; abbreviation?: string; slug?: string } }> }> }> };
    const out: string[] = [];
    for (const sport of body.sports ?? []) {
      for (const lg of sport.leagues ?? []) {
        for (const t of lg.teams ?? []) {
          // Prefer numeric id, then slug. Abbreviations ("BOU", "ARS") 400 on
          // the schedule endpoint — must use id or slug ("eng.bournemouth").
          const id = t.team?.id ?? t.team?.slug;
          if (id) out.push(id);
        }
      }
    }
    return out;
  } catch { return []; }
}

async function fetchBoxScorePlayers(competition: string, eventId: string): Promise<PlayerRef[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${competition}/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    // Soccer summary uses a top-level `rosters` array (one entry per team) with
    // `roster[]` of `{ athlete: { id, displayName } }` — not the basketball-style
    // `boxscore.players[].statistics[].athletes[]` shape.
    const body = await res.json() as {
      rosters?: Array<{
        team?: { abbreviation?: string };
        roster?: Array<{ athlete?: { id?: string; displayName?: string } }>;
      }>;
    };
    const out: PlayerRef[] = [];
    for (const tm of body.rosters ?? []) {
      for (const r of tm.roster ?? []) {
        if (r.athlete?.id && r.athlete?.displayName) {
          out.push({ id: r.athlete.id, name: r.athlete.displayName, team: tm.team?.abbreviation });
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();
  // European soccer seasons span calendar years (Aug–May), so for May 2026 the
  // "current" season returns no events. Walk back through y, y-1 until we have
  // a meaningful roster.
  for (const season of [y, y - 1]) {
    for (const competition of COMPETITIONS) {
      const teams = await fetchTeamsInCompetition(competition);
      for (const team of teams.slice(0, 8)) {  // sample first 8 teams per competition
        const eventsUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${competition}/teams/${team}/schedule?season=${season}`;
        try {
          const res = await fetch(eventsUrl, { headers: { "User-Agent": UA } });
          if (!res.ok) continue;
          const body = await res.json() as { events?: Array<{ id?: string }> };
          for (const e of (body.events ?? []).slice(0, 2)) {
            if (!e.id) continue;
            for (const p of await fetchBoxScorePlayers(competition, e.id)) {
              if (!seen.has(p.id)) seen.set(p.id, p);
            }
          }
        } catch { /* skip */ }
      }
    }
    if (seen.size > 50) break;
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  // ESPN soccer player gamelog isn't competition-scoped on the athlete URL — try a default path.
  // If a player appears in multiple competitions, ESPN returns merged events under their athlete ID.
  const out: RawGame[] = [];
  for (const season of seasons) {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/soccer/eng.1/athletes/${playerId}/gamelog?season=${season}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const data = await res.json() as { labels?: string[]; seasonTypes?: Array<{ categories?: Array<{ events?: Array<{ eventId: string; stats: string[] }> }> }>; events?: Record<string, { gameDate?: string; atVs?: "@" | "vs"; opponent?: { abbreviation?: string } }>; athlete?: { position?: { abbreviation?: string } } };
      const labels = data.labels ?? [];
      const isGoalie = data.athlete?.position?.abbreviation === "G" || data.athlete?.position?.abbreviation === "GK";
      const type = isGoalie ? "goalkeeper" : "field";
      for (const st of data.seasonTypes ?? []) {
        for (const cat of st.categories ?? []) {
          for (const evt of cat.events ?? []) {
            const statsObj: Record<string, number | string | null> = { type };
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
