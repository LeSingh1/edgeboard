// src/lib/sports/tennis/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const gamelogCache = new Map<string, RawGame[]>();
const rosterCache = new Map<string, PlayerRef>();

export async function fetchTeamSchedule(): Promise<string[]> {
  return [];
}

interface Linescore { value: number; }

interface CompetitorData {
  id?: string;
  winner?: boolean;
  athlete?: { displayName?: string };
  linescores?: Linescore[];
}

interface Competition {
  id?: string;
  date?: string;
  status?: { type?: { completed?: boolean } };
  competitors?: CompetitorData[];
}

function dateStringForWeeksAgo(weeksAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - weeksAgo * 7);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function extractMatchStats(
  player: CompetitorData,
  opponent: CompetitorData,
): Record<string, number | string | null> {
  const playerSets = player.linescores ?? [];
  const opponentSets = opponent.linescores ?? [];
  let setsWon = 0, gamesWon = 0, totalGames = 0;
  for (let i = 0; i < playerSets.length; i++) {
    const pg = playerSets[i]?.value ?? 0;
    const og = opponentSets[i]?.value ?? 0;
    gamesWon += pg;
    totalGames += pg + og;
    if (pg > og) setsWon++;
  }
  return { SETS: setsWon, GW: gamesWon, TOTAL_GAMES: totalGames };
}

async function ingestWeek(dateStr: string): Promise<void> {
  for (const tour of ["atp", "wta"] as const) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${dateStr}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const body = await res.json() as {
        events?: Array<{ groupings?: Array<{ competitions?: Competition[] }> }>;
      };
      for (const e of body.events ?? []) {
        for (const g of e.groupings ?? []) {
          for (const c of g.competitions ?? []) {
            if (!c.status?.type?.completed) continue;
            const comps = c.competitors ?? [];
            if (comps.length !== 2) continue;
            for (let pi = 0; pi < 2; pi++) {
              const player = comps[pi], opponent = comps[1 - pi];
              const id = player.id, name = player.athlete?.displayName;
              if (!id || !name) continue;
              if (!rosterCache.has(id)) rosterCache.set(id, { id, name });
              const game: RawGame = {
                eventId: c.id ?? "",
                gameDate: c.date ?? "",
                stats: extractMatchStats(player, opponent),
                isPlayoff: false,
              };
              const existing = gamelogCache.get(id) ?? [];
              existing.push(game);
              gamelogCache.set(id, existing);
            }
          }
        }
      }
    } catch { /* skip */ }
  }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  gamelogCache.clear();
  rosterCache.clear();
  for (let w = 0; w < 40; w++) {
    await ingestWeek(dateStringForWeeksAgo(w));
  }
  return [...rosterCache.values()];
}

export async function fetchPlayerGamelog(playerId: string, _seasons: number[]): Promise<RawGame[]> {
  return gamelogCache.get(playerId) ?? [];
}
