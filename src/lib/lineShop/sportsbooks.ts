/**
 * Sportsbook player-prop prices via The Odds API (https://the-odds-api.com).
 *
 * One API key covers DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, Fanatics,
 * BetRivers, etc. Set ODDS_API_KEY in .env.local. Without it this module
 * returns nothing and the tab runs on Kalshi (+ the EdgeBoard model) alone.
 *
 * Credit budget: the events list is free; each event's prop odds costs
 * (#markets × #regions) credits. To stay inside the free tier we
 *   - only fetch leagues that are on the PrizePicks board right now,
 *   - only request markets for stats PrizePicks is actually offering,
 *   - only fetch games starting in the next 36h (capped by ODDS_API_MAX_EVENTS),
 *   - cache every league's result for ODDS_API_TTL_MIN minutes (default 20).
 */

import { fetchWithTimeout } from "@/lib/sports/fetchWithTimeout";
import { LEAGUE_TO_ODDS_SPORT, ODDS_MARKETS, canonicalFromOddsMarket, familyOf, normPlayer } from "./stats";

const BASE = "https://api.the-odds-api.com/v4";

export interface BookQuote {
  league: string;
  player: string;          // normalized
  playerDisplay: string;
  canon: string;
  line: number;
  book: string;            // display title, e.g. "DraftKings"
  bookKey: string;
  over: number;            // American odds
  under: number;
}

export interface SportsbookStatus {
  configured: boolean;
  ok: boolean;
  quotes: number;
  books: string[];
  requestsRemaining: number | null;
  requestsUsed: number | null;
  error?: string;
  cachedAt?: string;
}

interface OddsEvent { id: string; commence_time: string; home_team: string; away_team: string }
interface OddsOutcome { name: string; description?: string; price: number; point?: number }
interface OddsEventOdds {
  bookmakers?: Array<{ key: string; title: string; markets?: Array<{ key: string; outcomes?: OddsOutcome[] }> }>;
}

const cache = new Map<string, { ts: number; quotes: BookQuote[] }>();
let lastRemaining: number | null = null;
let lastUsed: number | null = null;

function ttlMs(): number {
  const m = Number(process.env.ODDS_API_TTL_MIN ?? 20);
  return (Number.isFinite(m) && m > 0 ? m : 20) * 60_000;
}

function trackCredits(res: Response) {
  const rem = Number(res.headers.get("x-requests-remaining"));
  const used = Number(res.headers.get("x-requests-used"));
  if (Number.isFinite(rem)) lastRemaining = rem;
  if (Number.isFinite(used)) lastUsed = used;
}

/** Pure parser — exported for tests. Turns one event's odds payload into
 *  paired over/under quotes (a side without its partner is dropped). */
export function parseEventOdds(league: string, body: OddsEventOdds): BookQuote[] {
  const fam = familyOf(league);
  if (!fam) return [];
  const out: BookQuote[] = [];
  for (const bm of body.bookmakers ?? []) {
    for (const mk of bm.markets ?? []) {
      const canon = canonicalFromOddsMarket(fam, mk.key);
      if (!canon) continue;
      const pairs = new Map<string, { display: string; line: number; over?: number; under?: number }>();
      for (const o of mk.outcomes ?? []) {
        if (!o.description || typeof o.point !== "number") continue;
        const side = o.name.toLowerCase();
        if (side !== "over" && side !== "under") continue;
        const key = `${normPlayer(o.description)}|${o.point}`;
        const cur = pairs.get(key) ?? { display: o.description, line: o.point };
        if (side === "over") cur.over = o.price; else cur.under = o.price;
        pairs.set(key, cur);
      }
      for (const [key, v] of pairs) {
        if (v.over == null || v.under == null) continue;
        out.push({
          league, player: key.split("|")[0], playerDisplay: v.display, canon, line: v.line,
          book: bm.title, bookKey: bm.key, over: v.over, under: v.under,
        });
      }
    }
  }
  return out;
}

async function fetchLeague(league: string, canons: Set<string>): Promise<BookQuote[]> {
  const key = process.env.ODDS_API_KEY;
  const sport = LEAGUE_TO_ODDS_SPORT[league];
  const fam = familyOf(league);
  if (!key || !sport || !fam) return [];
  const markets = [...canons].map((c) => ODDS_MARKETS[fam][c]).filter(Boolean).sort();
  if (!markets.length) return [];
  const cacheKey = `${league}|${markets.join(",")}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < ttlMs()) return hit.quotes;

  const evRes = await fetchWithTimeout(`${BASE}/sports/${sport}/events?apiKey=${key}`, { cache: "no-store" }, 15_000);
  trackCredits(evRes);
  if (!evRes.ok) throw new Error(`Odds API events ${sport}: HTTP ${evRes.status}`);
  const events = (await evRes.json()) as OddsEvent[];
  const now = Date.now();
  const maxEvents = Number(process.env.ODDS_API_MAX_EVENTS ?? 16) || 16;
  const upcoming = events
    .filter((e) => {
      const t = new Date(e.commence_time).getTime();
      return t > now - 5 * 60_000 && t < now + 36 * 3_600_000;
    })
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
    .slice(0, maxEvents);

  const regions = process.env.ODDS_API_REGIONS ?? "us";
  const quotes: BookQuote[] = [];
  for (const ev of upcoming) {
    const url = `${BASE}/sports/${sport}/events/${ev.id}/odds?apiKey=${key}&regions=${regions}&markets=${markets.join(",")}&oddsFormat=american`;
    try {
      const res = await fetchWithTimeout(url, { cache: "no-store" }, 15_000);
      trackCredits(res);
      if (res.status === 401 || res.status === 429) throw new Error(`Odds API ${res.status} (key invalid or out of credits)`);
      if (!res.ok) continue;
      quotes.push(...parseEventOdds(league, (await res.json()) as OddsEventOdds));
    } catch (e) {
      if (String(e).includes("Odds API 4")) throw e;
    }
  }
  cache.set(cacheKey, { ts: Date.now(), quotes });
  return quotes;
}

/** Fetch sportsbook quotes for every (league → stats wanted) pair. Never throws. */
export async function fetchSportsbookQuotes(
  wanted: Map<string, Set<string>>,
): Promise<{ quotes: BookQuote[]; status: SportsbookStatus }> {
  const configured = Boolean(process.env.ODDS_API_KEY);
  if (!configured) {
    return {
      quotes: [],
      status: { configured, ok: false, quotes: 0, books: [], requestsRemaining: null, requestsUsed: null, error: "ODDS_API_KEY not set" },
    };
  }
  const quotes: BookQuote[] = [];
  const errors: string[] = [];
  for (const [league, canons] of wanted) {
    try {
      quotes.push(...(await fetchLeague(league, canons)));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  const books = [...new Set(quotes.map((q) => q.book))].sort();
  return {
    quotes,
    status: {
      configured,
      ok: errors.length === 0,
      quotes: quotes.length,
      books,
      requestsRemaining: lastRemaining,
      requestsUsed: lastUsed,
      error: errors[0],
      cachedAt: new Date().toISOString(),
    },
  };
}
