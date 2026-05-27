import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function fetchTeamSchedule(): Promise<string[]> {
  // PGA has no team schedules — return empty.
  return [];
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  // ESPN PGA rankings endpoint — top earners / world ranking
  const y = new Date().getFullYear();
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/rankings?season=${y}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { rankings?: Array<{ ranks?: Array<{ athlete?: { id?: string; displayName?: string } }> }> };
    const out: PlayerRef[] = [];
    const seen = new Set<string>();
    for (const ranking of body.rankings ?? []) {
      for (const rank of ranking.ranks ?? []) {
        if (rank.athlete?.id && rank.athlete?.displayName && !seen.has(rank.athlete.id)) {
          seen.add(rank.athlete.id);
          out.push({ id: rank.athlete.id, name: rank.athlete.displayName });
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/golf/pga/athletes/${playerId}/gamelog?season=${season}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const data = await res.json() as { labels?: string[]; seasonTypes?: Array<{ categories?: Array<{ events?: Array<{ eventId: string; stats: string[] }> }> }>; events?: Record<string, { gameDate?: string }> };
      const labels = data.labels ?? [];
      for (const st of data.seasonTypes ?? []) {
        for (const cat of st.categories ?? []) {
          for (const evt of cat.events ?? []) {
            const statsObj: Record<string, number | string | null> = {};
            for (let i = 0; i < labels.length; i++) {
              const v = evt.stats[i]; const n = parseFloat(v); statsObj[labels[i]] = Number.isFinite(n) ? n : v;
            }
            const meta = data.events?.[evt.eventId];
            out.push({ eventId: evt.eventId, gameDate: meta?.gameDate ?? "", stats: statsObj, isPlayoff: false });
          }
        }
      }
    } catch { /* skip */ }
  }
  return out;
}
