// src/lib/sports/tennis/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TOURS = ["atp", "wta"] as const;

export async function fetchTeamSchedule(): Promise<string[]> {
  // Tennis has no team schedules — player-centric. Return empty.
  return [];
}

async function fetchTourRankings(tour: string, year: number): Promise<PlayerRef[]> {
  // ESPN tennis rankings endpoint gives top-100 athletes
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/tennis/${tour}/rankings?season=${year}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { rankings?: Array<{ ranks?: Array<{ athlete?: { id?: string; displayName?: string } }> }> };
    const out: PlayerRef[] = [];
    for (const ranking of body.rankings ?? []) {
      for (const rank of ranking.ranks ?? []) {
        if (rank.athlete?.id && rank.athlete?.displayName) {
          out.push({ id: rank.athlete.id, name: rank.athlete.displayName });
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();
  for (const tour of TOURS) {
    for (const p of await fetchTourRankings(tour, y)) {
      if (!seen.has(p.id)) seen.set(p.id, p);
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    for (const tour of TOURS) {
      const url = `https://site.web.api.espn.com/apis/common/v3/sports/tennis/${tour}/athletes/${playerId}/gamelog?season=${season}`;
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
        // Player found in this tour — stop trying the other one
        if (out.length > 0) break;
      } catch { /* skip */ }
    }
  }
  return out;
}
