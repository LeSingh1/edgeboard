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
import { optimize, isUpcoming } from "@/lib/optimizer";
import { isLiveProjectionLeague, isBlockedSport } from "@/lib/projectionCoverage";
import type { Lineup, PickSide, Prop } from "@/lib/types";
import type { ProjectionResult } from "@/lib/realProjections";

/**
 * Which PrizePicks pick style the user wants the autopilot to lean into.
 *   balanced — default; rank by quality with small per-type bonuses.
 *   goblin   — easier lines (green goblins): higher hit rate, smaller payout.
 *   demon    — harder lines (red demons): lower hit rate, bigger payout.
 *   standard — plain over/under lines only.
 * The preference biases BOTH which variant we take per player and how the
 * candidate pool is ranked, so the final lineups actually reflect the choice.
 */
export type OddsPreference = "balanced" | "goblin" | "demon" | "standard";

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
  /** Lean the build toward a pick style (green goblins / red demons / standard).
   *  Defaults to "balanced". When set to a specific type, we take that variant
   *  per player when it exists and float matching props to the top of the pool,
   *  so the lineups returned actually reflect the preference. Demon preference
   *  also relaxes the probability floor (demons are intentionally < 50% to hit). */
  oddsPreference?: OddsPreference;
  /** The user EXPLICITLY asked for N lineups (vs. "give me some"). When true we
   *  widen the pool and, after strict diversity, top up to N from the ranked
   *  optimizer output even if those extra slips overlap heavily — N separate
   *  shots is the point. When false (default) we stop at the strictly-distinct
   *  set so "give me lineups" doesn't return near-clones. */
  fillToCount?: boolean;
  /** Favor CONSISTENT players over volatile ones when ranking the candidate
   *  pool. Consistency = the recent line-clear rate (fraction of recent games
   *  that landed on the bet's side); a player who clears the line game after
   *  game is weighted above a boom-or-bust player at the same hit probability.
   *  Only bites for picks with a real projection + recent games (implied picks
   *  get a small uncertainty nudge instead). Default off here; the page/chat
   *  pass the user's saved `favorConsistency` setting. */
  favorConsistency?: boolean;
  /** Hard "consistent players only" mode (vs. the softer `favorConsistency`
   *  weighting). Forces consistency weighting ON, raises the probability floor
   *  so coinflip picks are excluded, and DROPS players whose real projection is
   *  too volatile (CV above the cutoff). Picks without a real projection are
   *  kept (we can't disprove their consistency) but rank below verified-steady
   *  ones. Use when the user explicitly asks for "consistent / safe / steady
   *  players only". */
  consistentOnly?: boolean;
  /** Require a REAL projection model behind every pick (default true). Props from
   *  leagues with no inlined model (World Cup, Badminton, CS2, …) and covered-
   *  league props the model couldn't price (player/stat missing → real projection
   *  came back `available:false`) are excluded, so a slip can never be built on the
   *  flat PrizePicks-implied placeholder. Set false only for tests/diagnostics. */
  requireRealModel?: boolean;
  /** Reference "now" (epoch ms) for the game-started filter. Defaults to
   *  Date.now(); injectable so tests can pin time deterministically. */
  now?: number;
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
 *
 * When more lineups are requested the pool scales up so the optimizer has
 * enough distinct combinations to fill all slots with genuinely different picks.
 * Verified: C(base×1.5, k)×2^k stays well under 10M for all lineup sizes.
 *   6-8 lineups → ×1.25  (e.g. 3-pick pool 28→35)
 *   9-10 lineups → ×1.5  (e.g. 3-pick pool 28→42, C(42,3)×8 ≈ 92k)
 */
function poolCapFor(lineupSize: number, lineupCount: number): number {
  const base = lineupSize <= 2 ? 36 : lineupSize === 3 ? 28 : lineupSize === 4 ? 22 : lineupSize === 5 ? 18 : 14;
  if (lineupCount >= 9) return Math.round(base * 1.5);
  if (lineupCount >= 6) return Math.round(base * 1.25);
  return base;
}

/** Standard-normal CDF (Abramowitz-Stegun) — re-prices a flash-sale prop at its
 *  discounted line from the model's mean/sigma. */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-(z * z) / 2);
  const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? p : 1 - p;
}

/** The line a pick is actually BET at — the flash-sale discounted line when one
 *  is active, otherwise the standard line. */
export function effectiveLine(p: Prop): number {
  return p.flashSaleLine != null && p.flashSaleLine !== p.line ? p.flashSaleLine : p.line;
}

/** Patch implied probabilities with a real projection when one exists. */
function withRealProb(p: Prop, real?: Record<string, ProjectionResult>): Prop {
  const r = real?.[p.id];
  if (r && r.available) {
    // Flash sale: PrizePicks discounted the line in your favor. Price the pick
    // at the DISCOUNTED line (what you'd actually bet) by re-deriving the hit
    // probability from the model's mean/sigma at that easier line. The resulting
    // higher pMore makes the discounted pick naturally rank above full-price
    // peers — a real edge, so it's favored on merit, not a thumb on the scale.
    if (p.flashSaleLine != null && p.flashSaleLine !== p.line && r.sigma > 0) {
      const pMore = Math.max(0.02, Math.min(0.98, 1 - normCdf((p.flashSaleLine - r.projection) / r.sigma)));
      const round = (x: number) => Math.round(x * 1000) / 1000;
      // Keep `line` as the original so the UI can show "was 30.5"; the bet line
      // is read via effectiveLine(). pMore/pLess reflect the discounted line.
      return { ...p, pMore: round(pMore), pLess: round(1 - pMore), modelVersion: r.modelVersion };
    }
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
  preference: OddsPreference = "balanced",
): { prop: Prop; side: PickSide; prob: number } | null {
  const all = [vs.goblin, vs.standard, vs.demon].filter(Boolean) as Prop[];
  if (all.length === 0) return null;

  // Resolve one variant to its best playable side + probability.
  const resolve = (raw: Prop): { prop: Prop; side: PickSide; prob: number } => {
    const p = withRealProb(raw, real);
    // Goblin/demon are MORE-only on PrizePicks; standard can go either way.
    return p.oddsType !== "standard"
      ? { prop: p, side: "more", prob: p.pMore }
      : p.pMore >= p.pLess
        ? { prop: p, side: "more", prob: p.pMore }
        : { prop: p, side: "less", prob: p.pLess };
  };

  // An explicit pick-style preference is BINDING: take the wanted variant even
  // when its raw probability is lower — that lower hit rate (and bigger payout,
  // for demons) is exactly the tradeoff the user opted into. Families without
  // the wanted variant are SKIPPED, not substituted: a fallthrough to the
  // family's goblin/standard rung quietly refills the pool with easier picks,
  // and since the optimizer ranks slips by hit probability those substitutes
  // always outrank the real demons — "Red demons" mode then returns goblin
  // slips (observed on the 2026-06-11 WNBA board with a warm projection cache).
  if (preference !== "balanced") {
    const want = all.find((p) => p.oddsType === preference);
    return want ? resolve(want) : null;
  }

  // Compare variants by push-adjusted probability so a clean .5 line beats a
  // whole-number line of similar raw probability (whole numbers can push).
  let best: { prop: Prop; side: PickSide; prob: number } | null = null;
  let bestAdj = -1;
  for (const raw of all) {
    const candidate = resolve(raw);
    const adj = candidate.prob * pushPenalty(candidate.prop);
    if (adj > bestAdj) {
      bestAdj = adj;
      best = candidate;
    }
  }
  return best;
}

/**
 * Greedy diversity filter — keeps the top-ranked lineup, then accepts a lineup
 * only when it shares at most ~half its picks with any already-selected slip,
 * so "give me N lineups" yields genuinely different shots rather than N near-
 * clones. That's the whole point of playing several: independent chances, not
 * the same correlated bet repeated.
 *
 * If strict diversity can't fill `k` (a thin pool), the shortfall is filled with
 * the LEAST-overlapping leftovers — never the most-overlapping rank-order clones
 * the old version padded with.
 */
function selectDiverse(lineups: Lineup[], k: number, size: number, fill = false): Lineup[] {
  if (lineups.length === 0 || k <= 0) return [];
  const maxShared = Math.max(1, Math.floor(size * 0.5)); // ≤ ~half the picks shared
  const out: Lineup[] = [lineups[0]];
  const used = new Set<string>([lineups[0].id]);

  /** Most picks `l` shares with any lineup already chosen. */
  const overlapWith = (l: Lineup): number => {
    const lIds = new Set(l.picks.map((p) => p.prop.id));
    let max = 0;
    for (const e of out) {
      let s = 0;
      for (const p of e.picks) if (lIds.has(p.prop.id)) s++;
      if (s > max) max = s;
    }
    return max;
  };

  // Pass 1: strictly diverse (≤ maxShared overlap), best-ranked first.
  for (const l of lineups.slice(1)) {
    if (out.length >= k) break;
    if (overlapWith(l) <= maxShared) {
      out.push(l);
      used.add(l.id);
    }
  }
  // Pass 2: still short? Greedily add the leftover that overlaps LEAST with the
  // slips chosen so far (recomputed each step, so two fillers can't clone each
  // other) — but NEVER a near-clone: it must differ from every chosen slip by at
  // least 2 picks. If a thin pool can't reach `k` that way, return fewer; N
  // truly-different shots beats k overlapping ones (the caller surfaces "could
  // only fund N slips").
  const cloneBound = Math.max(1, size - 2); // differ in >= 2 picks
  while (out.length < k) {
    let best: Lineup | null = null;
    let bestOv = Infinity;
    for (const l of lineups) {
      if (used.has(l.id)) continue;
      const ov = overlapWith(l);
      if (ov < bestOv) {
        bestOv = ov;
        best = l;
      }
    }
    if (!best || bestOv > cloneBound) break; // nothing diverse enough left
    out.push(best);
    used.add(best.id);
  }

  // Pass 3 — fill mode only: the user explicitly asked for k slips, so top up
  // to k from the ranked optimizer output, accepting heavy overlap. These are
  // still DISTINCT lineups (the optimizer never emits two identical ones), just
  // not independent — which is the honest tradeoff of a thin board. We add in
  // rank order so the highest-quality leftovers come first. The caller surfaces
  // how much they overlap so the user knows these aren't 10 independent shots.
  if (fill && out.length < k) {
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
 * Model-driven lineup COUNT. Given the lineups the optimizer actually produced
 * (ranked best-first) and a ceiling, decide how many are worth playing instead
 * of forcing a fixed number. The signal is each lineup's `probProfit` (the
 * honest chance it returns more than its entry; falls back to hitProbability).
 *
 * Rule: always keep the single best, then keep each next lineup only while it
 * stays within `DROP` of the best AND clears an absolute floor. So one standout
 * on a thin board returns 1; several genuinely comparable slips return several;
 * a board with nothing strong still returns 1 (the user asked to build, and the
 * card's own metrics show how weak it is). This is "what the model thinks is
 * best, whether that is 1 slip or 5", not a hardcoded 3.
 *
 * DROP / FLOOR are heuristics, deliberately conservative so Auto leans toward
 * fewer, stronger slips rather than padding the count.
 */
export function recommendLineupCount(
  lineups: { probProfit?: number; hitProbability: number }[],
  ceiling: number,
): number {
  if (lineups.length === 0 || ceiling < 1) return Math.min(lineups.length, Math.max(0, ceiling));
  const q = (l: { probProfit?: number; hitProbability: number }) =>
    l.probProfit ?? l.hitProbability;
  const sorted = [...lineups].sort((a, b) => q(b) - q(a));
  const best = q(sorted[0]);
  const DROP = 0.08; // a slip must be within 8pp of the best to ride along
  const FLOOR = 0.4; // and never a slip below 40% to actually profit
  let n = 1; // always keep the single best
  for (let i = 1; i < sorted.length && n < ceiling; i++) {
    if (q(sorted[i]) >= Math.max(FLOOR, best - DROP)) n++;
    else break; // ranked, so once one falls off the rest do too
  }
  return n;
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
/**
 * Consistency multiplier from a player's RECENT LINE-CLEAR RATE — the fraction
 * of their recent games that actually landed on the bet's side of the line. A
 * player who clears the line in 5 of 5 recent games is reliable; one who clears
 * it in 2 of 5 is a coinflip dressed up as a projection. This beats coefficient
 * of variation, which wrongly punishes high-floor low-mean props (e.g. "Hits+
 * Runs+RBIs over 0.5" clears nearly every game but has a huge sigma/mean).
 *
 *   clear 1.0 (cleared every recent game) → 1.30×
 *   clear 0.7                              → ~1.09×
 *   clear 0.5 (coinflip)                   → ~0.95×
 *   clear 0.0                              → 0.60×
 *
 * `undefined` = no real projection / too few recent games: can't verify, so a
 * small uncertainty nudge (0.90×) rather than trusting it blindly.
 */
function consistencyFactor(clear: number | undefined): number {
  if (clear === undefined) return 0.9;
  return Math.max(0.6, Math.min(1.3, 0.6 + 0.7 * clear));
}

/**
 * Push-risk penalty. A WHOLE-NUMBER line (e.g. "over 6 assists") can land
 * EXACTLY on the number — on PrizePicks that's a push: the leg voids (Power
 * refunds, Flex drops the pick and pays the lower tier), which costs you the
 * win you were counting on. A HALF-POINT line (x.5) can never push — the result
 * is always cleanly over or under. So we always favor .5 lines: whole-number
 * lines get knocked down in the ranking, surfacing the cleaner .5 alternatives.
 * (The model's pMore also ignores the exact-landing mass, so it OVERrates whole
 * lines — this penalty corrects for both at the selection layer.)
 */
function pushPenalty(prop: Prop): number {
  return Number.isInteger(effectiveLine(prop)) ? 0.72 : 1;
}

function autoScore(
  c: { prop: Prop; prob: number; clear?: number },
  preference: OddsPreference = "balanced",
  favorConsistency = false,
): number {
  const { prob, prop } = c;
  const consistency = favorConsistency ? consistencyFactor(c.clear) : 1;
  // Always-on: favor .5 lines (no push risk) over whole-number lines.
  const push = pushPenalty(prop);

  // Explicit preference: float matching picks above ALL non-matching ones (a
  // big additive lift), still probability-ordered within each group. With the
  // small pool cap, this makes the pool preferred-dominated whenever the board
  // has enough of that style — so the optimizer's lineups reflect the choice.
  // Consistency reorders WITHIN each group (the ×factor can't lift a non-
  // preferred pick past the +10 float).
  if (preference !== "balanced") {
    return (prop.oddsType === preference ? prob + 10 : prob) * consistency * push;
  }

  // Balanced (default): blend probability with a per-type bonus — consistent
  // standard lines first, goblins for their payout-per-risk, demons last.
  let bonus = 1.0;
  if (prop.oddsType === "standard") {
    bonus = prob >= 0.65 ? 1.12 : 1.0;
  } else if (prop.oddsType === "goblin") {
    bonus = 1.06;
  } else if (prop.oddsType === "demon") {
    bonus = 0.92;
  }
  return prob * bonus * consistency * push;
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
  const preference = options.oddsPreference ?? "balanced";
  const consistentOnly = options.consistentOnly ?? false;
  // Hard consistent-only mode implies consistency weighting and a clear-rate bar.
  const favorConsistency = (options.favorConsistency ?? false) || consistentOnly;
  // No-mock-data gate (default ON): only real-model-priced props can become picks.
  const requireRealModel = options.requireRealModel ?? true;
  const now = options.now ?? Date.now();
  const MIN_CLEAR = 0.6; // must have cleared the line in >= 60% of recent games
  const families = groupByFamily(allProps);

  const seen = new Set<string>();
  const candidates: Array<{ prop: Prop; side: PickSide; prob: number; clear?: number }> = [];

  for (const p of allProps) {
    if (options.sport && options.sport !== "ALL" && p.sport !== options.sport) continue;
    // No-mock gate: a league with no inlined projection model only ever carries
    // the flat PrizePicks-implied placeholder, so it can never be a real pick.
    if (requireRealModel && !isLiveProjectionLeague(p.sport)) continue;
    // Hard no-bet block: sports with unreliable calibration data are prohibited
    // regardless of requireRealModel or modelVersion.
    if (isBlockedSport(p.sport)) continue;
    // Never surface a pick for a game that already started. A stale board
    // snapshot (PrizePicks blocks server fetches) keeps finished games frozen
    // as pre_game; this is what makes picks look "off" the morning after.
    if (requireRealModel && !isUpcoming(p, now)) continue;
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

    const best = bestVariant(vs, real, preference);
    if (!best) continue;

    // No-mock gate (per-prop): once a real projection has been fetched for this
    // prop and it came back unavailable (player/stat the model can't price), drop
    // it — its pMore/pLess are the implied placeholder, not a prediction. Props
    // not yet fetched are kept for pass-1 exploration; the page guarantees the
    // FINAL build only sees props whose real projection is available.
    if (requireRealModel && real?.[best.prop.id]?.available === false) continue;

    // Push-safe filter (learned from a real losing slip). A WHOLE-NUMBER line
    // can land exactly on the number and PUSH: Power voids the leg, Flex drops
    // it to the lower payout tier. autoScore only down-weights integer lines
    // (×0.72), which still let one ride into a "safe" slip — a 5-pick consistent
    // build carried Olivia Miles Under 6 assists, she landed on exactly 6, and
    // the push knocked the slip down a full flex tier. In a safe posture
    // (favor-consistency default or consistent-only) the point is to remove
    // avoidable loss paths, so here we EXCLUDE integer lines outright rather
    // than merely ranking them lower. Balanced/aggressive builds keep the
    // softer down-weight so a strong whole-number pick can still surface.
    if ((favorConsistency || consistentOnly) && Number.isInteger(effectiveLine(best.prop))) continue;

    // Probability floor. Demons are intentionally < 50% to hit, so a demon
    // preference would be filtered to nothing under the default 0.50 floor —
    // relax it for picks that match the preferred style the user opted into.
    // The demon floor must clear REAL model pricing, not just the implied
    // placeholder: implied demons sit at 0.40, but the calibrated model prices
    // typical board demons at ~0.22–0.38, so a 0.30 floor silently dropped most
    // demons on the pass-2 (real-backed) rebuild. 0.20 keeps the normal range
    // and still culls the hopeless tail.
    // Consistent-only raises the floor so coinflip picks never make the pool.
    const baseMin = Math.max(options.minProbability ?? 0.5, consistentOnly ? 0.62 : 0);
    const minProb =
      preference !== "balanced" && best.prop.oddsType === preference
        ? Math.min(baseMin, preference === "demon" ? 0.2 : 0.45)
        : baseMin;
    if (best.prob < minProb) continue;

    // Recent line-clear rate from the real projection's recent games: the
    // fraction that landed on this bet's side of the line. The honest "does
    // this player reliably clear it?" signal. Undefined for implied picks or
    // when we have fewer than 3 recent games to judge.
    const rp = real?.[best.prop.id];
    let clear: number | undefined;
    if (rp && rp.available && Array.isArray(rp.recent) && rp.recent.length >= 3) {
      const line = effectiveLine(best.prop);
      const hits = rp.recent.filter((v) =>
        best.side === "more" ? v > line : v < line,
      ).length;
      clear = hits / rp.recent.length;
    }
    // Consistent-only: drop players who haven't reliably cleared the line lately.
    // (Implied picks have no recent data — kept, but rank below verified ones.)
    if (consistentOnly && clear !== undefined && clear < MIN_CLEAR) continue;

    candidates.push({ ...best, clear });
  }

  candidates.sort(
    (a, b) =>
      autoScore(b, preference, favorConsistency) -
      autoScore(a, preference, favorConsistency),
  );

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

  // Pool cap keeps C(pool,k)×2^k tractable — do NOT widen it for fillToCount
  // (that blows up the optimizer's combination enumeration and OOMs). The
  // fill-to-count behavior tops up from the optimizer's existing ranked output
  // instead, which needs no extra pool material.
  const cap = options.maxPoolSize ?? poolCapFor(lineupSize, lineupCount);
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
    // Scale candidate count with lineups requested: selectDiverse needs a large
    // enough ranked list to find N genuinely different slips. 12× gives 120
    // candidates for 10 lineups vs the old 60, so Pass 1/2 diversity has more
    // to work with before Pass 3 fills with overlapping slips.
    maxResults: Math.max(lineupCount * 12, 60),
    // buildAutoLineups owns its own no-mock gate (league filter + the per-prop
    // real-availability check above), and uses a two-pass flow where pass-1
    // EXPLORES with still-implied props before pass-2 rebuilds from backed-only
    // props. optimize()'s modelVersion gate would wrongly drop those pass-1
    // exploration props (the board is implied-v1 until projections are fetched),
    // so it's disabled here. It stays ON for direct/manual optimize() callers.
    requireRealModel: false,
  });

  const picked = (options.diversify ?? true)
    ? selectDiverse(r.lineups, lineupCount, lineupSize, options.fillToCount ?? false).map((l, i) => ({ ...l, rank: i + 1 }))
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
