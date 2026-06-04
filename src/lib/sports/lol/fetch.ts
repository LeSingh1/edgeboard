import type { PlayerRef, RawGame } from "@/lib/sports/types";

// Leaguepedia (Fandom) Cargo API. Their policy asks for a descriptive
// User-Agent with contact info; shared/cloud IPs get rate-limited, so the
// roster pass pulls many rows in a few paged calls rather than one query
// per player.
const UA = "edgeboard-training/0.1 (contact: sshaurya914@gmail.com)";
const API = "https://lol.fandom.com/api.php";
const PAGE = 500;        // Cargo hard max per request
const MAX_PAGES = 120;   // up to ~60k scoreboard rows (≈ ten years of play)

interface CargoRow {
  title: {
    Link?: string;
    Team?: string;
    Champion?: string;
    Kills?: string;
    Deaths?: string;
    Assists?: string;
    CS?: string;
    DT?: string;
  };
}

const gamelogCache = new Map<string, RawGame[]>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rowToGame(t: CargoRow["title"]): RawGame {
  return {
    eventId: `${t.Link ?? ""}|${t.DT ?? ""}`,
    gameDate: t.DT ?? "",
    stats: {
      Kills: t.Kills ?? null,
      Deaths: t.Deaths ?? null,
      Assists: t.Assists ?? null,
      CS: t.CS ?? null,
      Champion: t.Champion ?? null,
    },
    isPlayoff: false,
  };
}

// Fandom's Cargo API rate-limits bursts: it answers with {error:{code:
// "ratelimited"}} and asks you to "wait some time". The old version treated
// that as a hard empty result, so one throttled page aborted the whole roster
// (the first page failing → zero players → zero training samples). Now a
// ratelimited / transient response is retried with exponential backoff; we
// only return [] for a real empty/末 page.
async function fetchPage(offset: number, attempts = 6): Promise<CargoRow[]> {
  const params = new URLSearchParams({
    action: "cargoquery",
    tables: "ScoreboardPlayers",
    fields: "Link,Team,Champion,Kills,Deaths,Assists,CS,DateTime_UTC=DT",
    order_by: "ScoreboardPlayers.DateTime_UTC DESC",
    limit: String(PAGE),
    offset: String(offset),
    format: "json",
  });
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
      if (!res.ok) { await sleep(Math.min(60000, 4000 * 2 ** i)); continue; }
      const body = await res.json() as { cargoquery?: CargoRow[]; error?: { code?: string } };
      if (body.error) { await sleep(Math.min(60000, 4000 * 2 ** i)); continue; } // ratelimited → wait & retry
      return body.cargoquery ?? [];
    } catch {
      await sleep(Math.min(60000, 4000 * 2 ** i));
    }
  }
  return [];
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  gamelogCache.clear();
  const seen = new Map<string, PlayerRef>();

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(1200);  // pace pages so we don't re-trip Fandom's rate limit
    const rows = await fetchPage(page * PAGE);
    if (rows.length === 0) break;
    for (const { title: t } of rows) {
      const id = t.Link;
      if (!id) continue;
      if (!seen.has(id)) seen.set(id, { id, name: id, team: t.Team });
      const log = gamelogCache.get(id) ?? [];
      log.push(rowToGame(t));
      gamelogCache.set(id, log);
    }
    if (rows.length < PAGE) break;  // last page
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, _seasons: number[]): Promise<RawGame[]> {
  return gamelogCache.get(playerId) ?? [];
}

// No per-team schedule concept in the Cargo model; the roster pass already
// pulls game rows directly.
export async function fetchTeamSchedule(_teamAbbr: string, _season: number): Promise<string[]> {
  return [];
}
