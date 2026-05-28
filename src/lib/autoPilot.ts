/**
 * Auto-Pilot lineup builder.
 *
 * The Optimizer page needs the user to first hand-pick props onto the bench.
 * Auto-Pilot collapses that: given the entire live board, pick the highest-
 * probability props automatically and run the same optimizer on the resulting
 * pool. The output is N "best chance to cash" lineups the user can play
 * straight away.
 *
 * Probability source:
 *   - When a real projection is cached in `realProjections` (because the user
 *     has visited the live board for that prop), we use it.
 *   - Otherwise we fall back to PrizePicks-implied. Implied math favors
 *     goblins (pMore ≈ 0.588) heavily — so unseeded runs lean goblin-heavy.
 *
 * Search-space discipline:
 *   - One pick per family (we choose the variant whose best side has the
 *     highest probability before handing to the optimizer).
 *   - Pool is capped by lineup size — C(pool, k) × 2^k grows fast; the caps
 *     keep a 6-pick generation under ~10M evaluations.
 *   - We pass NO variant table to the optimizer, so it doesn't re-explore
 *     goblin/std/demon swaps; the per-family choice we made above is final.
 */

import { groupByFamily, familyKeyOf, type VariantSet } from "@/lib/variantGroups";
import { optimize } from "@/lib/optimizer";
import type { Lineup, PickSide, Prop } from "@/lib/types";
import type { ProjectionResult } from "@/lib/realProjections";

export interface AutoPilotOptions {
  /** League name from the props feed, or "ALL" / undefined for no filter. */
  sport?: string;
  /** Hard cap on the candidate pool. If omitted, picked from `poolCapFor(lineupSize)`. */
  maxPoolSize?: number;
  /** Drop props whose best side falls below this probability. Default 0.50. */
  minProbability?: number;
  /** Drop currently-live games (they can lock mid-sort). Default true. */
  excludeLive?: boolean;
  /** Drop combo / multi-player props. Default true. */
  excludeCombo?: boolean;
  /** Cached real projections (from useProjectionStore). When a prop has one,
   *  we use it in place of the implied probability. */
  realProjections?: Record<string, ProjectionResult>;
  /** When true, prefer lineups that share fewer picks (up to ~70% overlap).
   *  Defaults to true — the user is asking for multiple lineups, they
   *  probably want some variety, not 5 near-identical slips. */
  diversify?: boolean;
  /** Hard filter: only include props whose team is in this set. Used by the
   *  "Playoff teams only" toggle to drop eliminated teams from the pool. */
  teamAllowlist?: Set<string>;
}

export interface AutoPilotResult {
  /** The candidate pool fed to the optimizer (already family-deduped + variant-resolved). */
  candidates: Prop[];
  lineups: Lineup[];
  poolSize: number;
  totalEvaluated: number;
  elapsedMs: number;
  /** How many candidates in the pool had a real projection backing their probability. */
  realProjectionCount: number;
}

/**
 * Compute-budget caps. C(n, k) × 2^k roughly grows by ~16× per increment in k,
 * so we shrink the pool as lineup size grows. These caps keep the worst case
 * under ~10M evaluations on a generation, well inside one frame in the browser.
 */
function poolCapFor(lineupSize: number): number {
  if (lineupSize <= 2) return 36;
  if (lineupSize === 3) return 28;
  if (lineupSize === 4) return 22;
  if (lineupSize === 5) return 18;
  return 14; // 6-pick
}

/** Patch implied probabilities with a real projection when one exists. */
function withRealProb(p: Prop, real?: Record<string, ProjectionResult>): Prop {
  const r = real?.[p.id];
  if (r && r.available) {
    return { ...p, pMore: r.pMore, pLess: r.pLess, modelVersion: r.modelVersion };
  }
  return p;
}

/**
 * Across goblin / standard / demon for one family, pick the variant whose
 * better side has the highest probability. demon/goblin are MORE-only on
 * PrizePicks, so for those we read pMore directly; for standard we take the
 * max of either side.
 */
function bestVariant(
  vs: VariantSet,
  real?: Record<string, ProjectionResult>,
): { prop: Prop; side: PickSide; prob: number } | null {
  const all = [vs.goblin, vs.standard, vs.demon].filter(Boolean) as Prop[];
  if (all.length === 0) return null;

  let best: { prop: Prop; side: PickSide; prob: number } | null = null;
  for (const raw of all) {
    const p = withRealProb(raw, real);
    const candidate: { prop: Prop; side: PickSide; prob: number } =
      p.oddsType !== "standard"
        ? { prop: p, side: "more", prob: p.pMore }
        : p.pMore >= p.pLess
          ? { prop: p, side: "more", prob: p.pMore }
          : { prop: p, side: "less", prob: p.pLess };
    if (!best || candidate.prob > best.prob) best = candidate;
  }
  return best;
}

/**
 * Greedy diversity filter — keeps the top-ranked lineup, then walks the rest
 * skipping any lineup that shares more than ~70% of its picks with one
 * already selected. If diversity leaves us short of `k`, the leftovers are
 * appended in rank order (so we always return as many as requested if the
 * optimizer found that many).
 */
function selectDiverse(lineups: Lineup[], k: number, size: number): Lineup[] {
  if (lineups.length === 0 || k <= 0) return [];
  const maxShared = Math.max(1, Math.floor(size * 0.7));
  const out: Lineup[] = [lineups[0]];
  const used = new Set<string>([lineups[0].id]);
  for (const l of lineups.slice(1)) {
    if (out.length >= k) break;
    const lIds = new Set(l.picks.map((p) => p.prop.id));
    const tooSimilar = out.some((existing) => {
      let shared = 0;
      for (const p of existing.picks) if (lIds.has(p.prop.id)) shared++;
      return shared > maxShared;
    });
    if (tooSimilar) continue;
    out.push(l);
    used.add(l.id);
  }
  if (out.length < k) {
    for (const l of lineups) {
      if (out.length >= k) break;
      if (used.has(l.id)) continue;
      out.push(l);
      used.add(l.id);
    }
  }
  return out;
}

/**
 * Sweep lineup sizes 2..6 with a small pool and pick the one whose top
 * lineup has the highest expected dollars ($-payout × hit-prob). Used by
 * the page when the user leaves "picks per lineup" on Auto.
 *
 * Each size is fast (the optimizer caps the pool per `poolCapFor`), so the
 * whole sweep finishes in well under a second on a typical board.
 */
export function pickAutoSize(
  allProps: Prop[],
  options: AutoPilotOptions = {},
): number {
  let bestSize = 4;
  let bestScore = -Infinity;
  for (const size of [2, 3, 4, 5, 6]) {
    const r = buildAutoLineups(allProps, size, 1, 20, { ...options, diversify: false });
    const top = r.lineups[0];
    if (!top) continue;
    // Expected gross dollars at $20 entry. Picks the size with the highest
    // long-run $-per-slip — naturally smaller for thin boards (less variance),
    // larger when there's enough material to support a big multiplier.
    const score = top.hitProbability * top.grossPayout - 20;
    if (score > bestScore) {
      bestScore = score;
      bestSize = size;
    }
  }
  return bestSize;
}

/**
 * Autopilot candidate score. Blends raw probability with a pick-type factor
 * so the pool ranking favors (1) consistent standard over/under picks, then
 * (2) goblins for their better payout-per-risk profile, then (3) demons last.
 *
 * Standard picks above ~0.65 get a confidence bonus because "always hitting"
 * standard lines are the safest autopilot foundation. Goblins get a flat lift
 * because the easier line + 0.85× payout stacks favorably in multi-pick
 * lineups. Demons are slightly penalized — higher payout but lower hit rate
 * makes them poor autopilot candidates.
 */
function autoScore(c: { prop: Prop; prob: number }): number {
  const { prob, prop } = c;
  let bonus = 1.0;
  if (prop.oddsType === "standard") {
    bonus = prob >= 0.65 ? 1.12 : 1.0;
  } else if (prop.oddsType === "goblin") {
    bonus = 1.06;
  } else if (prop.oddsType === "demon") {
    bonus = 0.92;
  }
  return prob * bonus;
}

/**
 * Score → top pool → optimize → diversity → return top K. See module header
 * for tradeoffs.
 */
export function buildAutoLineups(
  allProps: Prop[],
  lineupSize: number,
  lineupCount: number,
  entryCost: number,
  options: AutoPilotOptions = {},
): AutoPilotResult {
  const start = performance.now();
  const real = options.realProjections;
  const families = groupByFamily(allProps);

  const seen = new Set<string>();
  const candidates: Array<{ prop: Prop; side: PickSide; prob: number }> = [];

  for (const p of allProps) {
    if (options.sport && options.sport !== "ALL" && p.sport !== options.sport) continue;
    if ((options.excludeLive ?? true) && p.isLive) continue;
    if ((options.excludeCombo ?? true) && p.isCombo) continue;
    // Team allowlist (e.g. "alive playoff teams only"). Empty set = no filter.
    if (options.teamAllowlist && options.teamAllowlist.size > 0) {
      if (!p.team || !options.teamAllowlist.has(p.team.toUpperCase())) continue;
    }

    const fk = familyKeyOf(p);
    if (seen.has(fk)) continue;
    seen.add(fk);

    const vs = families.get(fk);
    if (!vs) continue;

    const best = bestVariant(vs, real);
    if (!best) continue;
    const minProb = options.minProbability ?? 0.5;
    if (best.prob < minProb) continue;

    candidates.push(best);
  }

  candidates.sort((a, b) => autoScore(b) - autoScore(a));

  // Per-league cap: PrizePicks limits how many picks from the same sub-league
  // can appear in a single lineup. Segment sports (1Q, 2Q, 1H, 2H, etc.)
  // are capped at 2; full-game sports have no hard cap. We enforce this at
  // the pool level so the optimizer never even sees an illegal combination.
  const leagueCounts = new Map<string, number>();
  const leagueCapped: typeof candidates = [];
  for (const c of candidates) {
    const league = c.prop.sport.toUpperCase();
    const isSegment = /\d[HQ]$/.test(league); // e.g. WNBA2H, NBA1Q
    const maxPerLeague = isSegment ? 2 : Infinity;
    const count = leagueCounts.get(league) ?? 0;
    if (count >= maxPerLeague) continue;
    leagueCounts.set(league, count + 1);
    leagueCapped.push(c);
  }

  const cap = options.maxPoolSize ?? poolCapFor(lineupSize);
  const pool = leagueCapped.slice(0, cap);
  const poolProps = pool.map((c) => c.prop);

  const realProjectionCount = real
    ? poolProps.filter((p) => real[p.id]?.available).length
    : 0;

  if (poolProps.length < lineupSize) {
    return {
      candidates: poolProps,
      lineups: [],
      poolSize: poolProps.length,
      totalEvaluated: 0,
      elapsedMs: Math.round(performance.now() - start),
      realProjectionCount,
    };
  }

  // No variantsByPropId → optimizer won't explore variant swaps. Side mask
  // enumeration in the optimizer naturally picks the higher-probability side
  // for each standard pick, which is exactly what we want for "safest" mode.
  const r = optimize({
    selectedProps: poolProps,
    lineupSize,
    entryCost,
    riskMode: "safe",
    maxResults: Math.max(lineupCount * 6, 60),
  });

  const picked = (options.diversify ?? true)
    ? selectDiverse(r.lineups, lineupCount, lineupSize).map((l, i) => ({ ...l, rank: i + 1 }))
    : r.lineups.slice(0, lineupCount).map((l, i) => ({ ...l, rank: i + 1 }));

  return {
    candidates: poolProps,
    lineups: picked,
    poolSize: poolProps.length,
    totalEvaluated: r.totalGenerated,
    elapsedMs: Math.round(performance.now() - start),
    realProjectionCount,
  };
}
