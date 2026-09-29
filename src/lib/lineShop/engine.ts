/**
 * Line Betting engine — cross-checks every PrizePicks standard prop against
 * sportsbooks (The Odds API) and Kalshi, then picks the side the market favors.
 *
 * Why this works: PrizePicks prices every standard pick as a coin flip — More
 * and Less pay the same. Sportsbooks and Kalshi don't: they charge more for
 * the side they think will hit. When DraftKings has "Over 245.5 −135 /
 * Under +110", the fair (vig-free) chance of the Over is ~55.5%, and PrizePicks
 * will pay you as if it were 50%. Stack three of those and the Power Play
 * multiplier starts working for you instead of against you.
 */

import type { Prop, PickSide } from "@/lib/types";
import type { KalshiSignal, KalshiSeriesInfo } from "@/lib/kalshi";
import type { BookQuote } from "./sportsbooks";
import { devigTwoWay, shiftPOver } from "./odds";
import {
  KALSHI_TITLE_RULES, LEAGUE_TO_KALSHI_PREFIX, canonicalStat, familyOf, normPlayer, statSd,
} from "./stats";

export type SourceKind = "book" | "kalshi" | "model";

export interface MarketSource {
  kind: SourceKind;
  name: string;            // "DraftKings", "Kalshi", "EdgeBoard model"
  line: number;            // line the source actually priced
  pOver: number;           // fair P(over PrizePicks line), after devig + line shift
  weight: number;
  exactLine: boolean;
  over?: number;           // American odds (books)
  under?: number;
  detail?: string;         // e.g. Kalshi ticker, spread
}

/** Where a pick's probability came from. "market" = at least one book or Kalshi. */
export type PickTier = "market" | "model" | "none";

export interface LinePick {
  id: string;              // PrizePicks prop id
  prop: Prop;
  canon: string | null;
  /** Uniqueness key across ALL lineups: same player + same stat = same pick. */
  uniqueKey: string;
  side: PickSide;
  /** Probability the chosen side hits (≥ 0.5 when tier is market/model). */
  p: number;
  pOver: number;
  tier: PickTier;
  sources: MarketSource[];
  /** Number of independent market sources (books + Kalshi). */
  marketCount: number;
}

// ── Kalshi series resolution ────────────────────────────────────────────────

/** Series we've confirmed by hand. Everything else comes from discovery. */
const KALSHI_STATIC: Record<string, string> = {
  "NBA|points": "KXNBAPTS", "NBA|assists": "KXNBAAST", "NBA|threes": "KXNBA3PT",
  "WNBA|points": "KXWNBAPTS", "WNBA|assists": "KXWNBAAST", "WNBA|threes": "KXWNBA3PT",
  "NFL|rec": "KXNFLREC", "NFL|pass_att": "KXNFLPASSATT",
  "NFL|pass_cmp": "KXNFLPASSCOMP", "NFL|rush_att": "KXNFLRSHATT",
};

/** Series that are NOT single-game player ladders even if the title matches. */
const NON_GAME_SERIES = /CAREER|SEASON|MVP|AWARD|LEADER|SPREAD|GAME|WINS?$|DRAFT|ROY|OPOY|DPOY/i;

/** Build league|canon → series ticker from the static map + discovered series. */
export function buildKalshiSeriesIndex(discovered: KalshiSeriesInfo[]): Map<string, string> {
  const idx = new Map<string, string>(Object.entries(KALSHI_STATIC));
  for (const [league, prefix] of Object.entries(LEAGUE_TO_KALSHI_PREFIX)) {
    const fam = familyOf(league);
    if (!fam) continue;
    for (const s of discovered) {
      if (!s.ticker.startsWith(prefix)) continue;
      if (NON_GAME_SERIES.test(s.ticker.slice(prefix.length))) continue;
      if (/career|season|winner|spread|moneyline|champion/i.test(s.title)) continue;
      if (/total/i.test(s.title) && !/total\s*bases/i.test(s.title)) continue; // game totals, not player ladders
      const rule = KALSHI_TITLE_RULES.find((r) => r.fam === fam && r.re.test(s.title));
      if (!rule) continue;
      const key = `${league}|${rule.canon}`;
      if (!idx.has(key)) idx.set(key, s.ticker);
    }
  }
  return idx;
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/** Can this PrizePicks prop go in a standard Power Play? */
export function isEligible(p: Prop, nowMs = Date.now()): boolean {
  if (p.oddsType !== "standard") return false; // goblins/demons change the payout
  if (p.isCombo || p.isLive || p.status !== "active") return false;
  const t = new Date(p.gameTime).getTime();
  if (Number.isFinite(t) && t < nowMs) return false;
  return true;
}

export function uniqueKeyOf(p: Prop): string {
  return `${p.sport.toUpperCase()}|${normPlayer(p.playerName)}|${p.statType.toLowerCase()}`;
}

// ── Core: price one prop ────────────────────────────────────────────────────

function indexQuotes(quotes: BookQuote[]): Map<string, BookQuote[]> {
  const idx = new Map<string, BookQuote[]>();
  for (const q of quotes) {
    const k = `${q.league}|${q.player}|${q.canon}`;
    const arr = idx.get(k);
    if (arr) arr.push(q); else idx.set(k, [q]);
  }
  return idx;
}

/** Sportsbook sources for one prop: at most one quote per book (closest line). */
export function bookSources(prop: Prop, canon: string, quotes: BookQuote[]): MarketSource[] {
  const sd = statSd(canon, prop.line);
  const byBook = new Map<string, BookQuote>();
  for (const q of quotes) {
    const cur = byBook.get(q.bookKey);
    if (!cur || Math.abs(q.line - prop.line) < Math.abs(cur.line - prop.line)) byBook.set(q.bookKey, q);
  }
  const out: MarketSource[] = [];
  for (const q of byBook.values()) {
    const diff = Math.abs(q.line - prop.line);
    if (diff > 1.5 * sd) continue; // too far apart to say anything honest
    const fair = devigTwoWay(q.over, q.under);
    if (fair == null) continue;
    const exact = diff < 1e-9;
    out.push({
      kind: "book",
      name: q.book,
      line: q.line,
      pOver: exact ? fair : shiftPOver(fair, q.line, prop.line, sd),
      weight: exact ? 1 : 0.6 * Math.exp(-diff / sd),
      exactLine: exact,
      over: q.over,
      under: q.under,
    });
  }
  return out;
}

export function kalshiSource(sig: KalshiSignal, prop: Prop): MarketSource {
  return {
    kind: "kalshi",
    name: "Kalshi",
    line: sig.threshold - 0.5,
    pOver: sig.pYes,
    // Kalshi prop ladders are thin; a 40¢-wide spread shouldn't outvote a book.
    weight: Math.max(0.05, Math.min(0.9, sig.confidence)),
    exactLine: Math.abs(sig.threshold - 0.5 - prop.line) < 1e-9,
    detail: `${sig.marketTicker} · spread ${(sig.spread * 100).toFixed(0)}¢`,
  };
}

function isModelPriced(p: Prop): boolean {
  return Boolean(p.modelVersion) && !p.modelVersion.startsWith("implied") && Number.isFinite(p.pMore);
}

/**
 * Price every eligible prop. `kalshiByPropId` holds Kalshi signals already
 * fetched for these props (network lives in the route, the math lives here).
 */
export function priceProps(
  props: Prop[],
  quotes: BookQuote[],
  kalshiByPropId: Map<string, KalshiSignal>,
  nowMs = Date.now(),
): LinePick[] {
  const qIdx = indexQuotes(quotes);
  const out: LinePick[] = [];
  for (const prop of props) {
    if (!isEligible(prop, nowMs)) continue;
    const league = prop.sport.toUpperCase();
    const canon = canonicalStat(league, prop.statType);
    const sources: MarketSource[] = [];
    if (canon) {
      sources.push(...bookSources(prop, canon, qIdx.get(`${league}|${normPlayer(prop.playerName)}|${canon}`) ?? []));
      const k = kalshiByPropId.get(prop.id);
      if (k) sources.push(kalshiSource(k, prop));
    }
    const market = sources.filter((s) => s.kind !== "model");
    let pOver: number;
    let tier: PickTier;
    if (market.length > 0) {
      const w = market.reduce((a, s) => a + s.weight, 0);
      pOver = market.reduce((a, s) => a + s.pOver * s.weight, 0) / w;
      tier = "market";
    } else if (isModelPriced(prop)) {
      pOver = prop.pMore;
      tier = "model";
    } else {
      pOver = 0.5;
      tier = "none";
    }
    if (isModelPriced(prop)) {
      // Shown for reference; never blended into a market price.
      sources.push({ kind: "model", name: "EdgeBoard model", line: prop.line, pOver: prop.pMore, weight: 0, exactLine: true });
    }
    pOver = Math.min(0.97, Math.max(0.03, pOver));
    const side: PickSide = pOver >= 0.5 ? "more" : "less";
    out.push({
      id: prop.id,
      prop,
      canon,
      uniqueKey: uniqueKeyOf(prop),
      side,
      p: side === "more" ? pOver : 1 - pOver,
      pOver,
      tier,
      sources,
      marketCount: market.length,
    });
  }
  return out;
}

const TIER_RANK: Record<PickTier, number> = { market: 0, model: 1, none: 2 };

/** Best picks first: market-backed before model-only before coin flips. */
export function rankPicks(picks: LinePick[]): LinePick[] {
  return [...picks].sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      b.p - a.p ||
      b.marketCount - a.marketCount ||
      a.id.localeCompare(b.id),
  );
}
