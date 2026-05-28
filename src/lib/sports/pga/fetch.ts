import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// In-memory cache built during fetchPlayerRoster, consumed by fetchPlayerGamelog.
const gamelogCache = new Map<string, RawGame[]>();

export async function fetchTeamSchedule(): Promise<string[]> {
  return [];
}

interface HoleScore {
  value: number;
  scoreType?: { displayValue?: string };
}

interface RoundData {
  value: number; // total strokes
  period: number;
  linescores?: HoleScore[];
  statistics?: { categories?: Array<{ stats?: Array<{ value?: number }> }> };
}

interface Competitor {
  id?: string;
  athlete?: { displayName?: string };
  score?: number | string;
  linescores?: RoundData[];
  status?: { type?: { name?: string } };
}

function dateStringForWeeksAgo(weeksAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - weeksAgo * 7);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchTournamentWeek(dateStr: string): Promise<Array<{ eventId: string; eventName: string; competitors: Competitor[] }>> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${dateStr}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { events?: Array<{ id: string; name?: string; status?: { type?: { name?: string } }; competitions?: Array<{ competitors?: Competitor[] }> }> };
    const out: Array<{ eventId: string; eventName: string; competitors: Competitor[] }> = [];
    for (const e of body.events ?? []) {
      if (e.status?.type?.name !== "STATUS_FINAL") continue;
      for (const c of e.competitions ?? []) {
        out.push({ eventId: e.id, eventName: e.name ?? "", competitors: c.competitors ?? [] });
      }
    }
    return out;
  } catch { return []; }
}

function extractRoundGames(eventId: string, eventName: string, competitor: Competitor): RawGame[] {
  const rounds = competitor.linescores ?? [];
  const games: RawGame[] = [];
  for (const rd of rounds) {
    const strokes = rd.value;
    if (!strokes || strokes <= 0) continue;

    const holes = rd.linescores ?? [];
    let birdies = 0, pars = 0, bogeys = 0, eagles = 0;
    for (const h of holes) {
      const st = h.scoreType?.displayValue ?? "";
      if (st === "-1") birdies++;
      else if (st === "E") pars++;
      else if (st === "+1") bogeys++;
      else if (st === "+2") bogeys++; // double bogey
      else if (st === "-2") eagles++;
      else if (st === "+3") bogeys++; // triple+
      else if (st === "-3") eagles++; // albatross
    }

    // Per-round stats from the API: [birdies, bogeys, ?, ?, eagles, pars, teeTime]
    const apiStats = rd.statistics?.categories?.[0]?.stats ?? [];
    const apiBirdies = apiStats[0]?.value;
    const apiPars = apiStats[5]?.value;

    games.push({
      eventId: `${eventId}-R${rd.period}`,
      gameDate: eventName,
      stats: {
        STROKES: strokes,
        BIRDIES: apiBirdies ?? birdies,
        PARS: apiPars ?? pars,
        BOGEYS: bogeys,
        EAGLES: eagles,
        BIRDIES_OR_BETTER: (apiBirdies ?? birdies) + eagles,
        FH: holes.length,
        GIR: null,
        PUTTS: null,
      },
      isPlayoff: false,
    });
  }
  return games;
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  gamelogCache.clear();
  const seen = new Map<string, PlayerRef>();

  // Fetch ~40 weeks of tournaments (roughly one PGA season)
  for (let w = 0; w < 40; w++) {
    const dateStr = dateStringForWeeksAgo(w);
    const tournaments = await fetchTournamentWeek(dateStr);
    for (const { eventId, eventName, competitors } of tournaments) {
      for (const comp of competitors) {
        const id = comp.id;
        const name = comp.athlete?.displayName;
        if (!id || !name) continue;
        if (!seen.has(id)) seen.set(id, { id, name });

        const roundGames = extractRoundGames(eventId, eventName, comp);
        const existing = gamelogCache.get(id) ?? [];
        existing.push(...roundGames);
        gamelogCache.set(id, existing);
      }
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, _seasons: number[]): Promise<RawGame[]> {
  return gamelogCache.get(playerId) ?? [];
}
