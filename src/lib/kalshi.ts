/**
 * Kalshi prediction-market adapter.
 *
 * Kalshi lists binary "yes/no" markets at coarse integer thresholds
 * (e.g., "Caitlin Clark: 25+ Points"). We resolve a PrizePicks prop into the
 * nearest matching Kalshi threshold, pull the bid/ask midpoint, and translate
 * back to a (pMore, pLess) pair the rest of the projection pipeline can blend.
 *
 * Coverage is intentionally narrow for now — Kalshi only lists Points,
 * Assists, and 3PT for NBA/WNBA. Adding more is just editing SERIES_MAP and
 * confirming the subtitle pattern in `parsePlayerAndThreshold`.
 *
 * The bid/ask spread on these markets is wide (most are illiquid market-maker
 * quotes, not real trades), so the returned `confidence` is largely driven by
 * spread tightness. The blend in `realProjections.ts` weights Kalshi by that
 * confidence so wide-spread markets only nudge the ESPN-model number, while
 * tight markets (rare) get more weight.
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

/**
 * Build Kalshi's signed-request headers, or an empty object if auth isn't
 * configured. Public endpoints (market list, market detail, prices) work
 * without these — we only set them when the user has both halves on hand
 * so the adapter degrades cleanly when they don't.
 *
 * Auth scheme per Kalshi docs:
 *   KALSHI-ACCESS-KEY        = the API key ID (UUID)
 *   KALSHI-ACCESS-TIMESTAMP  = epoch ms as a string
 *   KALSHI-ACCESS-SIGNATURE  = base64( RSA-PSS-SHA256( timestamp + method + path ) )
 *
 * Notes:
 *   - The path must include the query string Kalshi sees, not just the
 *     route, otherwise the signature is rejected.
 *   - PRIVATE_KEY_PATH points to a PEM file (-----BEGIN PRIVATE KEY-----).
 *     The file is read once per process and cached.
 *   - Any failure (missing file, bad permissions, bad PEM) is swallowed —
 *     the request still goes out, just unsigned. Public reads still work.
 */
let cachedPrivateKey: string | null | undefined;
function loadPrivateKey(): string | null {
  if (cachedPrivateKey !== undefined) return cachedPrivateKey;
  const path = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!path) {
    cachedPrivateKey = null;
    return null;
  }
  try {
    cachedPrivateKey = readFileSync(path, "utf8");
    return cachedPrivateKey;
  } catch {
    cachedPrivateKey = null;
    return null;
  }
}

function kalshiAuthHeaders(method: string, path: string): Record<string, string> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  const pem = loadPrivateKey();
  if (!keyId || !pem) return {};
  try {
    const ts = Date.now().toString();
    const msg = ts + method.toUpperCase() + path;
    const signer = createSign("RSA-SHA256");
    signer.update(msg);
    signer.end();
    const signature = signer.sign(
      { key: pem, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 /* SHA-256 digest length */ },
      "base64",
    );
    return {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": signature,
    };
  } catch {
    return {};
  }
}

/** PrizePicks (sport, statType) → Kalshi series ticker.
 *  WNBA1H / NBA1Q / etc. share the same series — Kalshi doesn't market segments. */
const SERIES_MAP: Record<string, string> = {
  "NBA|Points": "KXNBAPTS",
  "NBA|Assists": "KXNBAAST",
  "NBA|3PTM": "KXNBA3PT",
  "WNBA|Points": "KXWNBAPTS",
  "WNBA|Assists": "KXWNBAAST",
  "WNBA|3PTM": "KXWNBA3PT",
};

interface KalshiMarketRaw {
  ticker: string;
  yes_sub_title?: string;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  no_bid_dollars?: string | number;
  no_ask_dollars?: string | number;
  status?: string;
}

export interface KalshiSignal {
  /** Implied P(score ≥ matched threshold). Already interpolated to the prop's line. */
  pYes: number;
  /** The integer threshold we evaluated at (= ceil(line) for X.5 lines, line+1 for integer lines). */
  threshold: number;
  /** Matched market ticker (or pair if interpolated). */
  marketTicker: string;
  /** 0..1 — derived from bid/ask spread tightness. Wide-spread markets get low confidence. */
  confidence: number;
  /** ask - bid in dollars (0..1). Diagnostic. */
  spread: number;
}

function normName(s: string): string {
  // Strip diacritics ("Janelle Salaün" → "janelle salaun") so PP and Kalshi
  // spellings line up regardless of accent handling.
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Per-series in-memory cache. Markets list is sport-wide and refreshes once
// per minute; this avoids hammering Kalshi when many props of the same sport
// resolve in parallel.
const cache: Map<string, { ts: number; markets: KalshiMarketRaw[] }> = new Map();
const TTL_MS = 60_000;

async function fetchSeriesMarkets(series: string): Promise<KalshiMarketRaw[]> {
  const cached = cache.get(series);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.markets;
  const path = `/trade-api/v2/markets?series_ticker=${series}&status=open&limit=500`;
  const url = `https://api.elections.kalshi.com${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  // Optional auth — only used when both halves of Kalshi's two-part scheme
  // are configured. Public market reads work without auth; the signing path
  // exists so that future authenticated endpoints (portfolio, trading,
  // higher rate limits) can be reached without rewiring this adapter.
  Object.assign(headers, kalshiAuthHeaders("GET", path));
  try {
    const res = await fetch(url, { headers, next: { revalidate: 60 } });
    if (!res.ok) {
      cache.set(series, { ts: Date.now(), markets: [] });
      return [];
    }
    const data = (await res.json()) as { markets?: KalshiMarketRaw[] };
    const markets = data.markets ?? [];
    cache.set(series, { ts: Date.now(), markets });
    return markets;
  } catch {
    cache.set(series, { ts: Date.now(), markets: [] });
    return [];
  }
}

function parsePlayerAndThreshold(subtitle: string | undefined): { name: string; threshold: number } | null {
  if (!subtitle) return null;
  // "Naz Hillmon: 10+" → { name: "Naz Hillmon", threshold: 10 }
  const m = subtitle.match(/^(.+?):\s*(\d+)\+\s*$/);
  if (!m) return null;
  const n = m[1];
  const t = Number(m[2]);
  if (!n || !Number.isFinite(t)) return null;
  return { name: n.trim(), threshold: t };
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Bid/ask midpoint of a Kalshi market in dollars (0..1). Null if no usable quote. */
function quoteMidpoint(m: KalshiMarketRaw): number | null {
  const bid = num(m.yes_bid_dollars);
  const ask = num(m.yes_ask_dollars);
  if (ask <= 0) return null;
  // Bid can be 0 on truly one-sided markets — use ask/2 as a rough midpoint
  // there, since the only signal we have is "noone will pay more than ask".
  return bid > 0 ? (bid + ask) / 2 : ask / 2;
}

/**
 * Resolve a PrizePicks prop to a Kalshi-implied P(More).
 * Returns null if (sport, statType) isn't in SERIES_MAP, the player isn't
 * listed, or no nearby threshold has a usable quote.
 */
export async function kalshiSignalFor(prop: {
  sport: string;
  statType: string;
  playerName: string;
  line: number;
}): Promise<KalshiSignal | null> {
  const series = SERIES_MAP[`${prop.sport.toUpperCase()}|${prop.statType}`];
  if (!series) return null;
  const target = Number.isInteger(prop.line) ? prop.line + 1 : Math.ceil(prop.line);
  const markets = await fetchSeriesMarkets(series);
  if (markets.length === 0) return null;
  const targetName = normName(prop.playerName);
  const playerMarkets: Array<{ m: KalshiMarketRaw; threshold: number }> = [];
  for (const m of markets) {
    const parsed = parsePlayerAndThreshold(m.yes_sub_title);
    if (!parsed) continue;
    if (normName(parsed.name) !== targetName) continue;
    playerMarkets.push({ m, threshold: parsed.threshold });
  }
  if (playerMarkets.length === 0) return null;
  playerMarkets.sort((a, b) => a.threshold - b.threshold);
  // Closest market to our target threshold
  let best: { m: KalshiMarketRaw; threshold: number } | null = null;
  let bestDiff = Infinity;
  for (const pm of playerMarkets) {
    const diff = Math.abs(pm.threshold - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = pm;
    }
  }
  if (!best) return null;
  // If the closest market is too far from our target, bail — we'd be making
  // up data. ≤3 keeps things sane given Kalshi's 5-step ladder.
  if (bestDiff > 3) return null;
  const bestMid = quoteMidpoint(best.m);
  if (bestMid == null) return null;
  // Try to interpolate using the nearest market on the OTHER side of target.
  // Without this, a "Player: 15+" market would be reported as the answer for
  // a line=12.5 prop even though the true probability is meaningfully higher.
  let interpolatedMid = bestMid;
  let pairTicker: string | null = null;
  if (best.threshold !== target) {
    const otherSide = playerMarkets
      .filter((pm) => Math.sign(pm.threshold - target) !== Math.sign(best!.threshold - target) && pm.threshold !== best!.threshold)
      .sort((a, b) => Math.abs(a.threshold - target) - Math.abs(b.threshold - target));
    if (otherSide.length > 0) {
      const other = otherSide[0];
      const otherMid = quoteMidpoint(other.m);
      if (otherMid != null) {
        const t = (target - best.threshold) / (other.threshold - best.threshold);
        interpolatedMid = bestMid + t * (otherMid - bestMid);
        pairTicker = other.m.ticker;
      }
    }
  }
  // Clamp into a sensible range — extrapolating beyond Kalshi's listed
  // ladder occasionally produces 1.01-ish values from noisy quotes.
  const pYes = Math.max(0.02, Math.min(0.98, interpolatedMid));
  const bid = num(best.m.yes_bid_dollars);
  const ask = num(best.m.yes_ask_dollars);
  const spread = Math.max(0, ask - bid);
  // Confidence: tight spread → trust the price. A 5¢ spread is "tight" for
  // these illiquid markets; a 50¢ spread is "noise". Floor at 0.05 so even
  // wide-spread markets contribute a tiny pull toward the market mid.
  const confidence = Math.max(0.05, Math.min(0.9, 1 - spread));
  return {
    pYes,
    threshold: target,
    marketTicker: pairTicker ? `${best.m.ticker}+${pairTicker}` : best.m.ticker,
    confidence,
    spread,
  };
}

/**
 * Inverse-variance-style blend of an ESPN-model probability and a Kalshi
 * market-implied probability. `espnConfidence` is the caller's view of how
 * much to trust the ESPN side (typically derived from sample size).
 *
 * Returns the blended pMore plus the weight Kalshi got — useful for surfacing
 * "Kalshi contributed N%" in the explainer.
 */
export function blendPMore(
  espnPMore: number,
  espnConfidence: number,
  kalshi: KalshiSignal,
): { pMore: number; kalshiWeight: number } {
  const wE = Math.max(0.01, espnConfidence);
  const wK = Math.max(0.01, kalshi.confidence);
  const total = wE + wK;
  const pMore = (espnPMore * wE + kalshi.pYes * wK) / total;
  return { pMore, kalshiWeight: wK / total };
}
