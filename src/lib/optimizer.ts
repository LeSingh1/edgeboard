import type { Prop, PickSide, Lineup, PlayType, RiskMode } from "@/lib/types";
import type { VariantSet } from "@/lib/variantGroups";
import { hasRealModel } from "@/lib/projectionModel";

/** Lazy generator: every k-sized subset of arr. */
export function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  if (k < 0 || k > arr.length) return;
  // k === 0 MUST yield the empty combination so the `[first, ...c]` branch
  // below can build singletons. The old guard (`k <= 0` → return nothing)
  // silently dropped every combination that included the first element of any
  // sub-array, so the optimizer only ever evaluated lineups skewed toward the
  // LAST props in the list (e.g. 2-of-4 returned 3 pairs, not 6). This base
  // case is what makes the full lineup space actually get explored.
  if (k === 0) { yield []; return; }
  if (k === arr.length) { yield arr; return; }
  const [first, ...rest] = arr;
  for (const c of combinations(rest, k - 1)) yield [first, ...c];
  for (const c of combinations(rest, k)) yield c;
}

/**
 * Generate every variant assignment for a list of picks. Each pick may have
 * up to 3 variants (goblin/std/demon); this yields every cartesian combination.
 *
 *   variantAssignments([Curry(s), Brunson(s,d)], lookup)
 *     → [Curry(s), Brunson(s)]
 *     → [Curry(s), Brunson(d)]
 */
export function* variantAssignments(
  picks: Prop[],
  optionsFor: (p: Prop) => Prop[],
): Generator<Prop[]> {
  if (picks.length === 0) { yield []; return; }
  const [first, ...rest] = picks;
  const options = optionsFor(first);
  for (const opt of options) {
    for (const restAssign of variantAssignments(rest, optionsFor)) {
      yield [opt, ...restAssign];
    }
  }
}

function variantOptions(p: Prop, variantsByPropId?: Record<string, VariantSet>): Prop[] {
  if (!variantsByPropId) return [p];
  const vs = variantsByPropId[p.id];
  if (!vs) return [p];
  const out: Prop[] = [];
  if (vs.goblin) out.push(vs.goblin);
  if (vs.standard) out.push(vs.standard);
  if (vs.demon) out.push(vs.demon);
  return out.length > 0 ? out : [p];
}

/**
 * PrizePicks runs TWO payout schedules side by side, both shown to the user
 * on the lineup-review screen:
 *
 *   1. Minimum Guarantee — deterministic. Paid purely on how many picks
 *      hit. Doesn't depend on other entrants. This is what the user is
 *      actually playing for, so this is what EdgeBoard uses for the
 *      "$X if it lands" number and for all EV math.
 *
 *   2. "1st place pays" — tournament upside. Paid only if you finish 1st
 *      in the day's contest pool. Looks huge (25× / 37.5× on 6-pick) but
 *      it's a function of pool size and other entrants, NOT a guarantee.
 *      We surface these in the Model Lab payout-reference panel for
 *      visibility but never use them in EV.
 *
 * The two earlier (incorrect) versions of this file had:
 *   - "Reversion" MG schedule used as standard payouts (off by a goblin/
 *     demon-stack factor)
 *   - "Help-center standard rates" used as MG (off by ~4×; those are the
 *     tournament 1st-place values, not the floor)
 *
 * Ground truth for the MG values below: PrizePicks app → build a lineup →
 * review screen → "Minimum Guarantee" column. Verified by direct screenshot
 * 2026-05-26 on a 6-pick Flex w/ 2 goblins (observed: 6/6 = 4×, 5/6 = 0.5×,
 * 4/6 = 0.25×), back-solved to base via the published goblin factor 0.85.
 *
 * Values for sizes 2-5 are the codebase author's previously-confirmed MG
 * values. The 6-pick MG row is back-solved from one screenshot and marked
 * "estimated" until we've verified more goblin/demon stacks.
 */
export const POWER_MULTIPLIERS: Record<number, number> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 5.5,
};

/**
 * "1st place pays" tournament-prize schedule from PP's Payouts help-center
 * doc (prizepicks.com/help → Support → Payouts → "Player Pick Lineup
 * standard payout rates", last updated by PP 2026-04-23). These are NOT
 * the deterministic payouts — they're the prize-pool 1st-place numbers.
 * Surfaced in the UI alongside MG so the user sees both.
 */
export const POWER_FIRST_PLACE: Record<number, number> = {
  2: 3,
  3: 6,
  4: 10,
  5: 20,
  6: 37.5,
};

/** Provenance tag for every published multiplier. */
export type PayoutSource = "confirmed" | "estimated";

export const POWER_PROVENANCE: Record<number, PayoutSource> = {
  2: "confirmed",
  3: "confirmed",
  4: "confirmed",
  5: "confirmed",
  6: "estimated",
};

export interface FlexTier {
  hits: number;             // hits needed to land in this tier
  multiplier: number;       // payout multiplier
  source: PayoutSource;     // confirmed vs estimated
}

/**
 * Flex Play — Minimum Guarantee schedule. Values for sizes 3-5 are the
 * codebase author's previously-confirmed MG numbers. The 6-pick row is
 * back-solved from the 2026-05-26 screenshot of a 2-goblin 6-pick (4× /
 * 0.5× / 0.25×) divided by the goblin-factor stack (0.85² = 0.7225):
 *   6/6: 4 / 0.7225 ≈ 5.5   5/6: 0.5 / 0.7225 ≈ 0.7   4/6: 0.25 / 0.7225 ≈ 0.35
 */
export const FLEX_PAYOUT_TABLES: Record<number, FlexTier[]> = {
  3: [
    { hits: 3, multiplier: 3,    source: "confirmed" },
    { hits: 2, multiplier: 1,    source: "confirmed" },
  ],
  4: [
    { hits: 4, multiplier: 6,    source: "confirmed" },
    { hits: 3, multiplier: 1.5,  source: "confirmed" },
  ],
  5: [
    { hits: 5, multiplier: 10,   source: "confirmed" },
    { hits: 4, multiplier: 2,    source: "confirmed" },
    { hits: 3, multiplier: 0.4,  source: "confirmed" },
  ],
  6: [
    { hits: 6, multiplier: 5.5,  source: "estimated" },
    { hits: 5, multiplier: 0.7,  source: "estimated" },
    { hits: 4, multiplier: 0.35, source: "estimated" },
  ],
};

/**
 * Flex "1st place pays" tournament-prize schedule. From PP's help-center
 * "Player Pick Lineup standard payout rates". Display-only — never enters
 * the EV math.
 */
export const FLEX_FIRST_PLACE: Record<number, FlexTier[]> = {
  3: [
    { hits: 3, multiplier: 3,    source: "confirmed" },
    { hits: 2, multiplier: 1,    source: "confirmed" },
  ],
  4: [
    { hits: 4, multiplier: 6,    source: "confirmed" },
    { hits: 3, multiplier: 1.5,  source: "confirmed" },
  ],
  5: [
    { hits: 5, multiplier: 10,   source: "confirmed" },
    { hits: 4, multiplier: 2,    source: "confirmed" },
    { hits: 3, multiplier: 0.4,  source: "confirmed" },
  ],
  6: [
    { hits: 6, multiplier: 25,   source: "confirmed" },
    { hits: 5, multiplier: 2,    source: "confirmed" },
    { hits: 4, multiplier: 0.4,  source: "confirmed" },
  ],
};

/** ISO date the payout schedule above was last verified against PP's
 *  official help-center doc. Surfaces in the UI so users see the source. */
export const PAYOUT_SCHEDULE_VERIFIED_AT = "2026-04-23";

/**
 * Early-exit estimated payouts. PrizePicks publishes these as approximate
 * (≈) — the actual exit payout depends on current scoreboard state, sport
 * mix, and remaining game time. These are the published reference values
 * for projecting an early-exit number to the user.
 */
export const EARLY_EXIT_PAYOUTS: Record<string, number> = {
  "2/3": 3.2,
  "2/4": 2.75,
  "2/5": 2.8,
  "2/6": 2.8,
  "3/4": 5.25,
  "3/5": 5.4,
  "3/6": 5.3,
  "4/5": 10.4,
  "4/6": 10.25,
  "5/6": 19.6,
};

/**
 * Per-pick payout factor for demon/goblin odds_type.
 *
 *   - demon:    × 1.50 (PrizePicks-published base — line is harder)
 *   - goblin:   × 0.85 (PrizePicks-published base — line is easier)
 *   - standard: × 1.00
 *
 * STACKING
 * --------
 * Per-pick factors stack ADDITIVELY: factor = 1 + Σ(perPickFactor − 1). A
 * 4-pick with 2 demons pays baseMult × (1 + 2×0.5) = baseMult × 2.0, and 2
 * goblins pays baseMult × (1 − 2×0.15) = baseMult × 0.70 — both close to
 * PrizePicks's actual published behavior.
 *
 * This replaced an earlier MULTIPLICATIVE model (1.5² = 2.25 for 2 demons)
 * that over-credited multi-demon slips by ~10–20%. Combined with the board
 * historically pricing every demon at a flat 0.40 implied prob, that inflated
 * EV made the optimizer favor demon stacks on essentially every slip even
 * though demons rarely hit. Additive stacking + real model pricing
 * (boardPricing.ts) together remove that bias. Single demon/goblin slips are
 * unchanged (1.5 / 0.85). Result is floored at 0.1 so an all-goblin slip can't
 * drive the factor to zero.
 *
 * Still an estimate, not a binding quote — PrizePicks doesn't publish a full
 * lineup-size × demon-count × goblin-count table, so the /slips UI flags
 * payouts as approximate. Calibration to observed slips would tighten further.
 */
/** Per-pick payout factor. Exported so the UI's Payout Reference panel
 *  reads from the same source the EV math uses — no two-source drift.
 *
 *  Implied probability is derived from the factor (the more you'd be paid
 *  per pick relative to a coinflip, the rarer the line is implied to be):
 *    impliedPMore ≈ 1 / (1 + factor)  for demon (factor > 1)
 *    impliedPMore ≈ factor / (1 + factor)  for goblin (factor < 1)
 *  Both reduce to 0.5 at factor=1.0 (standard).
 */
export const ODDS_FACTOR: Record<Prop["oddsType"], number> = {
  standard: 1.0,
  demon: 1.5,
  goblin: 0.85,
};

/**
 * Combined per-slip payout factor from each pick's odds_type, stacked
 * ADDITIVELY (see the STACKING note above): 1 + Σ(perPickFactor − 1). Floored
 * at 0.1 so a deep all-goblin slip can't zero out the payout.
 */
export function oddsPayoutFactor(props: Prop[]): number {
  const stacked = props.reduce((acc, p) => acc + ((ODDS_FACTOR[p.oddsType] ?? 1) - 1), 1);
  return Math.max(0.1, stacked);
}

/**
 * MORE-only invariant. PrizePicks demon & goblin variants have NO LESS side —
 * you can only enter MORE. `optimize()` pins them to MORE at generation, but a
 * pick can still arrive at a render carrying side:"less" if it was built against
 * an older board snapshot where that rung was a standard line and the board
 * later repriced it to a demon/goblin. Showing that stale LESS (e.g. a demon
 * "LESS 4.5 · 95%") reads as a playable lock when it isn't enterable at all.
 *
 * Normalize any pick to the side a user could actually enter on PrizePicks,
 * paired with that side's probability. `repriced:true` flags that we had to
 * flip a non-standard pick off LESS — the UI surfaces a "line moved" warning so
 * the stale 95% isn't mistaken for a real edge. Standard picks pass through
 * unchanged (both sides are enterable).
 */
export function enterablePick(
  prop: Pick<Prop, "oddsType" | "pMore" | "pLess">,
  side: PickSide,
  probability: number,
): { side: PickSide; probability: number; repriced: boolean } {
  if (prop.oddsType !== "standard" && side === "less") {
    // Only MORE is enterable; show its true probability (pMore), falling back to
    // the complement of the stored LESS prob if pMore is somehow absent.
    const moreProb = Number.isFinite(prop.pMore) ? prop.pMore : 1 - probability;
    return { side: "more", probability: moreProb, repriced: true };
  }
  return { side, probability, repriced: false };
}

/** Poisson Binomial DP: probability of exactly h hits among k independent picks. */
export function poissonBinomial(probs: number[]): number[] {
  let dp = [1];
  for (const p of probs) {
    const next = new Array(dp.length + 1).fill(0);
    for (let k = 0; k < dp.length; k++) {
      next[k]     += dp[k] * (1 - p);
      next[k + 1] += dp[k] * p;
    }
    dp = next;
  }
  return dp;
}

/**
 * Build a direction-agnostic game key — Robinson (NYK vs CLE) and Allen
 * (CLE vs NYK) are in the SAME game, so we sort the team pair before joining.
 * Also includes sport so NBA-Lakers and MLB-Lakers (hypothetical) don't collide,
 * and the calendar date so a Lakers-vs-Suns game on Mon doesn't match a
 * Lakers-vs-Suns game on Wed.
 */
function gameKey(p: Prop): string {
  const pair = [p.team, p.opponent].map((s) => (s ?? "").toUpperCase()).sort().join("@");
  const day = (p.gameTime ?? "").slice(0, 10);
  return `${pair}::${(p.sport ?? "").toUpperCase()}::${day}`;
}

/**
 * PrizePicks lineup-validity rule: every entered lineup must include players
 * from at least 2 different teams. A 4-pick slip of all-Cavaliers picks, for
 * example, is not enterable on PP regardless of how strong each individual
 * pick is. We treat this as a hard filter (drop the lineup entirely) rather
 * than a soft correlation penalty.
 *
 * Combo props (e.g. "Donovan Mitchell + Jalen Brunson") report a single
 * `team` so they count as one team here — same as PP's own behavior.
 *
 * Returns true when the lineup is enterable, false when it would be
 * rejected at the PP entry screen.
 */
export function meetsTeamDiversity(props: Prop[]): boolean {
  const teams = new Set<string>();
  for (const p of props) {
    const t = (p.team ?? "").trim().toUpperCase();
    if (t) teams.add(t);
  }
  // Lineups with no team data at all (e.g. PGA / esports where `team` is
  // empty) are exempt — the PP rule is NBA / team-sport flavored.
  if (teams.size === 0) return true;
  return teams.size >= 2;
}

export function correlationRisk(props: Prop[]): "low" | "medium" | "high" {
  const players = props.map((p) => p.playerName);
  if (new Set(players).size < players.length) return "high";
  const games = props.map(gameKey);
  if (new Set(games).size < games.length) return "medium";
  return "low";
}

const RHO: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 0.2,
  high: 0.45,
};

export function applyCorrelationPenalty(pIndependent: number, props: Prop[]): number {
  const risk = correlationRisk(props);
  const rho = RHO[risk];
  if (rho === 0) return pIndependent;
  const k = props.length;
  const totalPairs = (k * (k - 1)) / 2;
  let correlatedPairs = 0;
  for (let i = 0; i < props.length; i++) {
    for (let j = i + 1; j < props.length; j++) {
      const a = props[i], b = props[j];
      const sameGame = gameKey(a) === gameKey(b);
      if (a.playerName === b.playerName || sameGame) correlatedPairs++;
    }
  }
  return pIndependent * (1 - rho * (correlatedPairs / totalPairs));
}

/**
 * Detect a "reversion lineup" — PrizePicks's term for a slip where most or all
 * picks are from the same game. PrizePicks applies a reduced payout multiplier
 * to these slips (typically 5–10% less than the standard payout) to compensate
 * for the heavy correlation. Their app shows the warning:
 *   "Reversion lineup payouts are different than standard."
 *
 * Returns:
 *   - "full"    — every pick is in one game (strongest correlation)
 *   - "partial" — half or more share a game, but not all
 *   - "none"    — picks are spread across multiple games
 *
 * Also returns the dominant-game size for UI copy ("3 of 4 picks share NYK/CLE").
 */
/**
 * Multiplicative payout discount that PrizePicks applies to reversion lineups.
 * Calibrated against PP's "5–10% less" published range:
 *   - full   → 7.5% off (midpoint of stated range)
 *   - partial→ 3% off (gentler — half-shared games get a partial discount)
 *   - none   → 1.0 (no discount)
 *
 * Applied to `grossPayout` in both Power and Flex so EV reflects what
 * PrizePicks will actually pay out, not what the base multiplier table says.
 */
export function reversionPayoutFactor(props: Prop[]): number {
  const r = detectReversion(props);
  if (r.level === "full") return 0.925;
  if (r.level === "partial") return 0.97;
  return 1.0;
}

export function detectReversion(props: Prop[]): {
  level: "full" | "partial" | "none";
  sharedCount: number;
  totalPicks: number;
} {
  if (props.length < 2) {
    return { level: "none", sharedCount: 0, totalPicks: props.length };
  }
  const counts = new Map<string, number>();
  for (const p of props) {
    const k = gameKey(p);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const maxCount = Math.max(...counts.values());
  if (maxCount === props.length) {
    return { level: "full", sharedCount: maxCount, totalPicks: props.length };
  }
  if (maxCount >= 2 && maxCount / props.length >= 0.5) {
    return { level: "partial", sharedCount: maxCount, totalPicks: props.length };
  }
  return { level: "none", sharedCount: maxCount, totalPicks: props.length };
}

export interface OptimizeParams {
  selectedProps: Prop[];
  lineupSize: number;
  entryCost: number;
  riskMode: RiskMode;
  maxResults?: number;
  /**
   * Sibling variants for each picked prop, keyed by propId. When provided,
   * the optimizer considers swapping variants (goblin/std/demon) as an
   * additional dimension when generating lineups.
   */
  variantsByPropId?: Record<string, VariantSet>;
  /**
   * Restrict to a specific play type. When omitted, both Power AND Flex
   * are generated for each lineup shape; sorting surfaces the best.
   */
  playType?: PlayType;
  /**
   * No-mock gate (default true): drop any prop still carrying the flat
   * PrizePicks-implied placeholder (`modelVersion === "implied-v1"`) before
   * building, so a slip can never be priced on a coinflip. A prop is kept only
   * once a real game-log projection has stamped a real modelVersion onto it.
   * Set false only for tests/diagnostics.
   */
  requireRealModel?: boolean;
  /**
   * Reference "now" (epoch ms) for the game-started filter. Defaults to
   * Date.now(); injectable so tests can pin time deterministically.
   */
  now?: number;
}

/**
 * A prop is bettable only BEFORE its game starts. The board snapshot can be
 * many hours stale (PrizePicks hard-blocks server-side fetches, so the route
 * falls back to its last good pull), and a finished game stays frozen in that
 * snapshot as `pre_game` — so without this guard the model happily prices and
 * surfaces picks for games that already ended. That is the classic "the picks
 * are off" bug. Missing/unparseable start times are treated as upcoming so we
 * never over-filter the rare malformed row.
 */
export function isUpcoming(prop: Prop, now: number = Date.now()): boolean {
  const t = Date.parse(prop.gameTime);
  return Number.isNaN(t) || t > now;
}

export interface FilterOptions {
  minHitProb?: number;   // 0..1
  minEv?: number;        // absolute dollar EV
}

interface ComputedLineup {
  picks: { prop: Prop; side: PickSide; probability: number }[];
  hitProbability: number;
  /** Probability the lineup returns MORE than its entry cost — i.e. an actual
   *  profit. Differs from hitProbability for Flex, where the lowest paying tier
   *  (e.g. 3/5 → 0.4×) "cashes" but still loses money. This is the honest
   *  "chance you end up ahead on this slip" number. */
  probProfit: number;
  expectedValue: number;
  grossPayout: number;
  payoutMultiplier: number;
  correlationRisk: "low" | "medium" | "high";
  playType: PlayType;
}

function computePower(
  props: Prop[],
  sides: PickSide[],
  entryCost: number,
): ComputedLineup {
  const picks = props.map((prop, i) => ({
    prop,
    side: sides[i],
    probability: sides[i] === "more" ? prop.pMore : prop.pLess,
  }));
  const probs = picks.map((p) => p.probability);
  const oddsFactor = oddsPayoutFactor(props);
  const pIndependent = probs.reduce((a, b) => a * b, 1);
  const hitProbability = applyCorrelationPenalty(pIndependent, props);
  const baseMult = POWER_MULTIPLIERS[props.length] ?? 0;
  // Reversion discount — PrizePicks pays less for same-game lineups.
  // Applied to the displayed payout so EV reflects what PP actually pays out.
  const reversionFactor = reversionPayoutFactor(props);
  const payoutMultiplier = baseMult * oddsFactor * reversionFactor;
  const grossPayout = entryCost * payoutMultiplier;
  const expectedValue = hitProbability * grossPayout - entryCost;
  // Power pays all-or-nothing, so you profit exactly when every pick hits —
  // provided the multiplier actually exceeds 1× (a deep goblin stack can dip
  // below break-even). hitProbability already folds in the correlation penalty.
  const probProfit = payoutMultiplier > 1 ? hitProbability : 0;
  return {
    picks,
    hitProbability,
    probProfit,
    expectedValue,
    grossPayout,
    payoutMultiplier,
    correlationRisk: correlationRisk(props),
    playType: "power",
  };
}

function computeFlex(
  props: Prop[],
  sides: PickSide[],
  entryCost: number,
): ComputedLineup | null {
  if (props.length < 3) return null; // Flex only supports 3+
  const picks = props.map((prop, i) => ({
    prop,
    side: sides[i],
    probability: sides[i] === "more" ? prop.pMore : prop.pLess,
  }));
  const probs = picks.map((p) => p.probability);
  const oddsFactor = oddsPayoutFactor(props);
  // Same reversion discount applies to Flex tiers — PrizePicks reduces all
  // partial-hit tier multipliers proportionally on a same-game slip.
  const reversionFactor = reversionPayoutFactor(props);
  const dist = poissonBinomial(probs);
  const tiers = FLEX_PAYOUT_TABLES[props.length] ?? [];
  let ev = -entryCost;
  let pAny = 0;
  let pProfit = 0;
  let topMult = 0;
  for (const tier of tiers) {
    const adjustedMult = tier.multiplier * oddsFactor * reversionFactor;
    topMult = Math.max(topMult, adjustedMult);
    const p = dist[tier.hits] ?? 0;
    ev += p * entryCost * adjustedMult;
    pAny += p;
    // Only tiers that pay MORE than the stake are an actual profit. The bottom
    // Flex tier (e.g. 3/5 → 0.4×) "cashes" but still loses 60% — it must NOT
    // count toward the honest profit probability.
    if (adjustedMult > 1) pProfit += p;
  }
  return {
    picks,
    hitProbability: pAny,
    probProfit: pProfit,
    expectedValue: ev,
    grossPayout: entryCost * topMult,
    payoutMultiplier: topMult,
    correlationRisk: correlationRisk(props),
    playType: "flex",
  };
}

export function optimize({
  selectedProps: rawSelectedProps,
  lineupSize,
  entryCost,
  riskMode,
  maxResults = 50,
  variantsByPropId,
  playType,
  requireRealModel = true,
  now = Date.now(),
  filters,
}: OptimizeParams & { filters?: FilterOptions }): { lineups: Lineup[]; totalGenerated: number; elapsedMs: number } {
  const start = performance.now();
  // No-mock gate: a prop still on the implied placeholder has no real projection
  // behind it, so it can never enter a computed slip. We also drop games that
  // have already started — a stale board snapshot otherwise leaves finished
  // games pickable. Together these cover every optimizer-driven surface
  // (SmartSuggest, BestSingleSlip, the optimizer page).
  const selectedProps = requireRealModel
    ? rawSelectedProps.filter((p) => hasRealModel(p.modelVersion) && isUpcoming(p, now))
    : rawSelectedProps;
  const lineups: Lineup[] = [];
  let counter = 0;

  // ── Enumerate: combinations × variant assignments × side masks × play types ──
  // PrizePicks rule: demon/goblin variants are MORE-only. We only iterate over
  // "free" positions (standard variant) in the side mask; non-standard
  // positions are pinned to MORE. This shrinks the search space and keeps
  // every emitted lineup actually enterable on PrizePicks.
  for (const combo of combinations(selectedProps, lineupSize)) {
    // Hard skip: PrizePicks rejects lineups that don't span ≥2 different
    // teams. We bail before any variant / side enumeration so we don't waste
    // work computing payouts on an unenterable combo.
    if (!meetsTeamDiversity(combo)) continue;
    for (const variantCombo of variantAssignments(combo, (p) => variantOptions(p, variantsByPropId))) {
      // Indices in variantCombo whose side is the user's choice (standard only)
      const freeIdx: number[] = [];
      for (let i = 0; i < variantCombo.length; i++) {
        if (variantCombo[i].oddsType === "standard") freeIdx.push(i);
      }
      const freeCount = freeIdx.length;

      for (let mask = 0; mask < (1 << freeCount); mask++) {
        // Decode mask: free positions get the bit, pinned positions = "more"
        const sides: PickSide[] = variantCombo.map((p) => (p.oddsType === "standard" ? "less" : "more"));
        for (let b = 0; b < freeCount; b++) {
          if ((mask >> b) & 1) sides[freeIdx[b]] = "more";
        }

        // Power play
        if (!playType || playType === "power") {
          counter++;
          const power = computePower(variantCombo, sides, entryCost);
          lineups.push({
            id: `lineup-${start.toFixed(0)}-${counter}-p`,
            rank: 0,
            ...power,
            netProfit: power.grossPayout - entryCost,
            entryCost,
          });
        }

        // Flex play — only for 3+
        if ((!playType || playType === "flex") && lineupSize >= 3) {
          const flex = computeFlex(variantCombo, sides, entryCost);
          if (flex) {
            counter++;
            lineups.push({
              id: `lineup-${start.toFixed(0)}-${counter}-f`,
              rank: 0,
              ...flex,
              netProfit: flex.grossPayout - entryCost,
              entryCost,
            });
          }
        }
      }
    }
  }

  // Sort by risk mode
  const sortKey =
    riskMode === "safe"
      ? (l: Lineup) => -l.hitProbability
      : riskMode === "aggressive"
        ? (l: Lineup) => -l.expectedValue + (l.correlationRisk === "high" ? -2 : 0)
        : (l: Lineup) =>
            -l.expectedValue *
            (l.correlationRisk === "high"
              ? 0.7
              : l.correlationRisk === "medium"
                ? 0.9
                : 1);

  // Apply filters (if any)
  const filtered = lineups.filter((l) => {
    if (filters?.minHitProb !== undefined && l.hitProbability < filters.minHitProb) return false;
    if (filters?.minEv !== undefined && l.expectedValue < filters.minEv) return false;
    return true;
  });

  filtered.sort((a, b) => sortKey(a) - sortKey(b));
  // Dedupe by pick-signature (same picks + sides + playType) — keeps the leaderboard tidy.
  // After sort: the better-EV duplicate wins.
  const seen = new Set<string>();
  const deduped: Lineup[] = [];
  for (const l of filtered) {
    const sig =
      l.playType +
      "|" +
      l.picks
        .map((p) => `${p.prop.id}:${p.side}`)
        .sort()
        .join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(l);
    if (deduped.length >= maxResults) break;
  }
  const top = deduped.map((l, i) => ({ ...l, rank: i + 1 }));

  return {
    lineups: top,
    totalGenerated: counter,
    elapsedMs: Math.round(performance.now() - start),
  };
}

/**
 * Round-robin "variations" of a fixed set of picks.
 *
 * Given the picks the user likes (e.g. the 5 in their top lineup), build every
 * smaller sub-lineup (sizes 3..N) and return the best `count` by honest chance
 * to profit. This is the real hedge behind "give me variations so if one hits I
 * profit": with 5 picks there are C(5,3)=10 three-pick combos, C(5,4)=5 four-
 * pick combos, etc. If, say, 3 of the 5 land, the 3-pick combo of exactly those
 * three CASHES even though the full 5-pick missed.
 *
 * Sides are NOT re-explored away from the user's intent: "safe" sorting keeps
 * each standard pick on its higher-probability side, which is the side that put
 * it in a high-confidence lineup to begin with — so the variations show the
 * same Over/Under directions the user already has.
 *
 * IMPORTANT (honesty): these variations are NOT independent — they're drawn
 * from the same N picks, so a single missed pick takes down every sub-lineup
 * that contains it. They cash on PARTIAL outcomes (a 3-of-5 day), which is the
 * genuine benefit; they are not N independent shots. The caller surfaces this.
 */
export function buildVariations(
  seedPicks: { prop: Prop; side: PickSide }[],
  entryCost: number,
  count: number,
): Lineup[] {
  const all: Lineup[] = [];
  const maxSize = Math.min(seedPicks.length, 6);
  let counter = 0;

  // Enumerate every sub-combination of the seed picks at sizes 3..N, pricing
  // both Power and Flex. Crucially we DON'T re-explore sides here (that's what
  // turned the round-robin into side-flips of one combo) — each player stays on
  // the side the user picked. We just vary WHICH players are in each slip.
  for (let size = 3; size <= maxSize; size++) {
    for (const combo of combinations(seedPicks, size)) {
      const props = combo.map((c) => c.prop);
      // Skip un-enterable combos (PrizePicks needs 2+ teams).
      if (!meetsTeamDiversity(props)) continue;
      const sides = combo.map((c) => c.side);

      const power = computePower(props, sides, entryCost);
      all.push({
        id: `var-${size}-${++counter}-p`,
        rank: 0,
        ...power,
        netProfit: power.grossPayout - entryCost,
        entryCost,
      });

      const flex = computeFlex(props, sides, entryCost);
      if (flex) {
        all.push({
          id: `var-${size}-${++counter}-f`,
          rank: 0,
          ...flex,
          netProfit: flex.grossPayout - entryCost,
          entryCost,
        });
      }
    }
  }

  // Rank by honest chance to actually profit, then by upside. probProfit
  // already excludes Flex tiers that cash but lose (e.g. 3/5 → 0.4×). Smaller
  // sub-lineups naturally float up (they hit more often) — exactly the hedge:
  // a 3-of-5 day still cashes the right 3-pick combo.
  all.sort(
    (a, b) =>
      (b.probProfit ?? b.hitProbability) - (a.probProfit ?? a.hitProbability) ||
      b.grossPayout - a.grossPayout,
  );
  // Dedupe by player-set + sides + play type so the same combo doesn't repeat.
  const seen = new Set<string>();
  const out: Lineup[] = [];
  for (const l of all) {
    const sig =
      l.playType +
      "|" +
      l.picks.map((p) => `${p.prop.id}:${p.side}`).sort().join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(l);
    if (out.length >= count) break;
  }
  return out.map((l, i) => ({ ...l, rank: i + 1 }));
}

// ════════════════════════════════════════════════════════════════════
// Recommendation engine: best lineup at each size + an overall pick
// ════════════════════════════════════════════════════════════════════

export interface SizeRecommendation {
  size: number;
  /** Auto-chosen play type for this size's winning lineup. */
  playType: PlayType;
  best: Lineup | null;          // top lineup of this size
  /** Best lineup at this size if play type is forced to Power. May equal
   *  `best` when Power was already the auto choice; null when no valid
   *  Power lineup exists (e.g. all variants disqualify combos). */
  bestPower: Lineup | null;
  /** Best lineup at this size if play type is forced to Flex. null for
   *  size < 3 (Flex isn't available below 3-pick) or when no valid Flex
   *  lineup exists. */
  bestFlex: Lineup | null;
  totalEvaluated: number;       // total lineups generated
  countPositiveEv: number;      // how many of those are +EV
  countAboveMinHit: number;     // how many clear the min-hit-% filter
}

export interface RecommendResult {
  bySize: SizeRecommendation[];
  recommended: SizeRecommendation | null;
  mode: RiskMode;
}

/**
 * For each valid lineup size (2..min(N,6)), find the single best lineup
 * given the user's picks + filters. Play type (Power vs Flex) is chosen
 * automatically per lineup based on the mode's sort criterion.
 *   safe       → highest hit %
 *   balanced   → highest EV among slips with ≥ 10% hit prob
 *   aggressive → highest EV regardless of hit prob
 */
export function recommendLineups({
  selectedProps,
  entryCost,
  riskMode,
  variantsByPropId,
  filters,
}: {
  selectedProps: Prop[];
  entryCost: number;
  riskMode: RiskMode;
  variantsByPropId?: Record<string, VariantSet>;
  filters?: FilterOptions;
}): RecommendResult {
  const N = selectedProps.length;
  const bySize: SizeRecommendation[] = [];

  const validSizes: number[] = [];
  for (let k = 2; k <= Math.min(N, 6); k++) {
    validSizes.push(k);
  }

  for (const size of validSizes) {
    // Single combined pass: generates both Power and Flex, sorted by mode
    const r = optimize({
      selectedProps,
      lineupSize: size,
      entryCost,
      riskMode,
      maxResults: 200,
      variantsByPropId,
      filters,
    });
    const best = r.lineups[0] ?? null;
    // Per-play-type best so the UI can flip between Power and Flex without
    // re-running optimize(). The lineups list is already sorted by the
    // mode's criterion, so .find() returns the best of that play type.
    const bestPower = r.lineups.find((l) => l.playType === "power") ?? null;
    const bestFlex = r.lineups.find((l) => l.playType === "flex") ?? null;
    const countPositiveEv = r.lineups.filter((l) => l.expectedValue > 0).length;
    const countAboveMinHit = filters?.minHitProb
      ? r.lineups.filter((l) => l.hitProbability >= filters.minHitProb!).length
      : r.lineups.length;
    bySize.push({
      size,
      playType: best?.playType ?? "power",
      best,
      bestPower,
      bestFlex,
      totalEvaluated: r.totalGenerated,
      countPositiveEv,
      countAboveMinHit,
    });
  }

  const valid = bySize.filter((s) => s.best !== null);
  let recommended: SizeRecommendation | null = null;
  if (valid.length) {
    if (riskMode === "safe") {
      recommended = valid.reduce((a, b) =>
        (b.best!.hitProbability > a.best!.hitProbability ? b : a),
      );
    } else if (riskMode === "aggressive") {
      recommended = valid.reduce((a, b) =>
        (b.best!.expectedValue > a.best!.expectedValue ? b : a),
      );
    } else {
      // balanced: best EV with hit ≥ 10%, else best EV
      const withProb = valid.filter((s) => (s.best!.hitProbability ?? 0) >= 0.10);
      const pool = withProb.length ? withProb : valid;
      recommended = pool.reduce((a, b) =>
        (b.best!.expectedValue > a.best!.expectedValue ? b : a),
      );
    }
  }

  return { bySize, recommended, mode: riskMode };
}
