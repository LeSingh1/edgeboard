/**
 * Board pricing — wires the real, trained projection model into the live
 * board feed (`/api/props`).
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Historically every prop on the board was priced by `impliedProbability(oddsType)`
 * — a 3-value lookup (standard 0.500 / demon 0.400 / goblin 0.588) that ignores
 * the player, the line, recent form, and all 13 trained calibration models. That
 * made `pMore × payoutFactor` a constant per odds type: demon 0.60 > standard 0.50
 * > goblin 0.50, so the optimizer ranked demons first on EVERY board, regardless
 * of whether the line would actually hit. That's the "always favors red demons"
 * bias.
 *
 * The real model already exists — `projectionFor()` (sport adapter + ESPN game
 * logs + Kalshi) and `applyCalibrationToResult()` (the trained per-stat ×
 * per-oddsType isotonic calibration). It just wasn't connected to the board.
 *
 * THE CONSTRAINT
 * --------------
 * `projectionFor()` makes live network calls per prop and a full board is ~15k
 * props, so we can neither price the whole board synchronously nor warm all of
 * it in one burst (that would hammer ESPN/Kalshi and risk an IP block).
 *
 * THE DESIGN
 * ----------
 *   1. A module-level cache keyed by a stable SEMANTIC signature
 *      (player|stat|line|oddsType|gameTime|sport) — survives PrizePicks's
 *      per-pull `id` churn so the cache stays warm across the ISR window.
 *      Entries are positive (real model price) OR negative (no model available
 *      for this prop — e.g. an out-of-season sport with no adapter) so we don't
 *      re-attempt the unpriceable ones every pass.
 *   2. `applyCachedPricing(props)` — synchronous, fast. Cache HIT with a real
 *      price → trained-model pMore/pLess + real modelVersion. MISS or negative
 *      → leaves the implied fallback untouched (tagged `implied-v1`), so the
 *      board is never blank or slow.
 *   3. `warmBoardPricing(props)` — async, fire-and-forget via Next's `after()`.
 *      Prices up to MAX_WARM_PER_PASS uncached props per call, PRIORITIZED by
 *      popularity (trendingCount), at bounded concurrency. The board converges
 *      to real pricing over successive fetches; popular props upgrade first.
 *
 * Net effect: first paint shows tagged implied numbers; the most-viewed props
 * upgrade to real model pricing within a fetch or two, and demons priced at
 * their true (low) hit-rate stop dominating the EV sort.
 */

import type { Prop } from "@/lib/types";
import { projectionFor, applyCalibrationToResult } from "@/lib/realProjections";

interface CachedProjection {
  /** false = negative cache: no real model for this prop, keep the implied
   *  fallback and don't re-attempt until the entry expires. */
  available: boolean;
  pMore: number;
  pLess: number;
  modelVersion: string;
  computedAt: number;
}

/** Cache entries older than this are re-warmed. Matches the board's ISR window
 *  with headroom so a prop priced on one pull is still fresh on the next. */
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

/** Max real-model projections in flight at once during a warm. The sport
 *  adapters cache game logs per player, so shared-player props amortize after
 *  the first call; this just bounds the burst against ESPN / Kalshi. */
const WARM_CONCURRENCY = 8;

/** Cap on how many props one warm pass will price. A full board is ~15k props;
 *  warming all at once would be a huge outbound burst. Instead each board fetch
 *  warms a bounded, popularity-prioritized batch and the cache converges over
 *  successive fetches. */
const MAX_WARM_PER_PASS = 150;

/** Keyed by semantic signature (see `signatureFor`). Lives for the process
 *  lifetime of the route worker. Memory is negligible (a few KB per entry,
 *  capped by the number of distinct props on a slate). */
const cache = new Map<string, CachedProjection>();

/** Signatures currently being priced — prevents two concurrent warms from
 *  projecting the same prop twice. */
const inFlight = new Set<string>();

/** Guards against stacking warmers: at most one warm pass runs at a time. */
let warming = false;

/**
 * Stable semantic identity for a prop's pricing. Deliberately excludes the
 * PrizePicks `id` (which rotates every pull) so a prop we priced 2 minutes ago
 * is still a cache hit on the next board refresh. Includes everything that
 * actually changes the probability: who, what stat, what line, which odds
 * variant, and which game (so the same line in two different games prices
 * independently).
 */
export function signatureFor(p: Prop): string {
  return [
    p.sport.toUpperCase(),
    p.playerName.trim().toLowerCase(),
    p.statType.trim().toLowerCase(),
    p.line,
    p.oddsType,
    (p.gameTime ?? "").slice(0, 16), // to the minute — enough to separate games
  ].join("|");
}

/**
 * Enrich props from the cache, returning new objects (never mutates the input).
 * Only positive (available) cache hits upgrade a prop; misses and negative
 * entries leave the implied fallback in place. Returns the enriched list plus a
 * summary the UI can surface ("N / M priced by model").
 */
export function applyCachedPricing(props: Prop[]): {
  props: Prop[];
  pricedByModel: number;
  total: number;
} {
  let pricedByModel = 0;
  const now = Date.now();
  const out = props.map((p) => {
    const hit = cache.get(signatureFor(p));
    if (hit && hit.available && now - hit.computedAt < CACHE_TTL_MS) {
      pricedByModel++;
      return { ...p, pMore: hit.pMore, pLess: hit.pLess, modelVersion: hit.modelVersion };
    }
    return p;
  });
  return { props: out, total: props.length, pricedByModel };
}

/** True when this prop still needs a real-model attempt (no fresh cache entry —
 *  positive or negative — and not already being priced by a concurrent warm). */
function needsWarming(p: Prop, now: number): boolean {
  const sig = signatureFor(p);
  if (inFlight.has(sig)) return false;
  const hit = cache.get(sig);
  return !hit || now - hit.computedAt >= CACHE_TTL_MS;
}

/**
 * Price uncached props with the real model + trained calibration and fill the
 * cache. Safe to call fire-and-forget (e.g. `after(() => warmBoardPricing(p))`).
 * Never throws — a per-prop failure leaves that prop on the implied fallback.
 *
 * Warms at most MAX_WARM_PER_PASS props, most-popular-first, so a single pass is
 * a bounded burst; remaining props warm on later fetches. Returns counts so the
 * cap is observable, not silent.
 */
export async function warmBoardPricing(props: Prop[]): Promise<{
  priced: number;
  attempted: number;
  remaining: number;
}> {
  if (warming) return { priced: 0, attempted: 0, remaining: 0 };
  warming = true;
  let priced = 0;
  try {
    const now = Date.now();
    // Dedupe by signature, keep only props that still need an attempt, then
    // prioritize by popularity so the props users actually look at upgrade
    // first.
    const bySig = new Map<string, Prop>();
    for (const p of props) {
      const sig = signatureFor(p);
      if (!bySig.has(sig) && needsWarming(p, now)) bySig.set(sig, p);
    }
    const candidates = [...bySig.entries()].sort(
      (a, b) => (b[1].trendingCount ?? 0) - (a[1].trendingCount ?? 0),
    );
    const remaining = Math.max(0, candidates.length - MAX_WARM_PER_PASS);
    const queue = candidates.slice(0, MAX_WARM_PER_PASS);
    const attempted = queue.length;
    if (remaining > 0) {
      // Not a silent truncation — report what we deferred to the next pass.
      console.info(
        `[boardPricing] warming ${attempted} props this pass, ${remaining} deferred to next fetch`,
      );
    }
    for (const [sig] of queue) inFlight.add(sig);

    const worker = async () => {
      for (;;) {
        const next = queue.pop();
        if (!next) return;
        const [sig, prop] = next;
        try {
          let r = await projectionFor(prop);
          r = await applyCalibrationToResult(
            r,
            prop.oddsType,
            prop.statType,
            prop.gameTime,
            prop.team,
          );
          if (r.available) {
            cache.set(sig, {
              available: true,
              pMore: r.pMore,
              pLess: r.pLess,
              modelVersion: r.modelVersion,
              computedAt: Date.now(),
            });
            priced++;
          } else {
            // Negative cache: no model for this prop (no adapter / too few
            // games). Keep the implied fallback and skip it next pass instead
            // of paying the lookup again every fetch.
            cache.set(sig, {
              available: false,
              pMore: prop.pMore,
              pLess: prop.pLess,
              modelVersion: prop.modelVersion,
              computedAt: Date.now(),
            });
          }
        } catch {
          // Isolate: one bad prop never aborts the batch. Left uncached so a
          // transient failure is retried on the next pass.
        } finally {
          inFlight.delete(sig);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker),
    );
    return { priced, attempted, remaining };
  } finally {
    warming = false;
  }
}

/** Test/maintenance hook — clears the in-memory pricing cache. */
export function __resetBoardPricingCache(): void {
  cache.clear();
  inFlight.clear();
  warming = false;
}
