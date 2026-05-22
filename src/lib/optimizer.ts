import type { Prop, PickSide, Lineup, PlayType, RiskMode } from "@/lib/types";
import type { VariantSet } from "@/lib/variantGroups";

/** Lazy generator: every k-sized subset of arr. */
export function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  if (k > arr.length || k <= 0) return;
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
 * PrizePicks Power Play multipliers — current, documented in PrizePicks help center.
 *   2-pick: 3×   3-pick: 5×   4-pick: 10×   5-pick: 20×   6-pick: 25×
 */
export const POWER_MULTIPLIERS: Record<number, number> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 25,
};

export interface FlexTier {
  hits: number;       // hits needed to land in this tier
  multiplier: number; // payout multiplier
}

/**
 * PrizePicks Flex Play partial-hit payout tables, current PrizePicks values.
 * Order: best payout (all hit) first.
 */
export const FLEX_PAYOUT_TABLES: Record<number, FlexTier[]> = {
  3: [
    { hits: 3, multiplier: 2.25 },
    { hits: 2, multiplier: 1.25 },
  ],
  4: [
    { hits: 4, multiplier: 5 },
    { hits: 3, multiplier: 1.5 },
  ],
  5: [
    { hits: 5, multiplier: 10 },
    { hits: 4, multiplier: 2 },
    { hits: 3, multiplier: 0.4 },
  ],
  6: [
    { hits: 6, multiplier: 25 },
    { hits: 5, multiplier: 2 },
    { hits: 4, multiplier: 0.4 },
  ],
};

/**
 * Per-pick payout factor for demon/goblin odds_type, stacks multiplicatively
 * with the lineup-size multiplier.
 *
 *   - demon:    × 1.50 (PrizePicks-published base; deeper demons can go higher)
 *   - goblin:   × 0.85 (PrizePicks-published base; deeper goblins can go lower)
 *   - standard: × 1.00
 *
 * IMPORTANT: PrizePicks doesn't ship per-projection multipliers in their public
 * JSON — these factors are computed client-side in their app, and the actual
 * payout can vary slightly with how far the demon/goblin line is from standard
 * (a "deep demon" 3 lines above standard pays more than a "close demon" 0.5
 * above). The 1.5× / 0.85× values match the PrizePicks help-center docs and
 * land within ~5% of observed payouts for most slips. See user-facing note
 * in /optimizer caption.
 */
const ODDS_FACTOR: Record<Prop["oddsType"], number> = {
  standard: 1.0,
  demon: 1.5,
  goblin: 0.85,
};

export function oddsPayoutFactor(props: Prop[]): number {
  return props.reduce((acc, p) => acc * (ODDS_FACTOR[p.oddsType] ?? 1), 1);
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
}

export interface FilterOptions {
  minHitProb?: number;   // 0..1
  minEv?: number;        // absolute dollar EV
}

interface ComputedLineup {
  picks: { prop: Prop; side: PickSide; probability: number }[];
  hitProbability: number;
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
  const payoutMultiplier = baseMult * oddsFactor;
  const grossPayout = entryCost * payoutMultiplier;
  const expectedValue = hitProbability * grossPayout - entryCost;
  return {
    picks,
    hitProbability,
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
  const dist = poissonBinomial(probs);
  const tiers = FLEX_PAYOUT_TABLES[props.length] ?? [];
  let ev = -entryCost;
  let pAny = 0;
  let topMult = 0;
  for (const tier of tiers) {
    const adjustedMult = tier.multiplier * oddsFactor;
    topMult = Math.max(topMult, adjustedMult);
    const p = dist[tier.hits] ?? 0;
    ev += p * entryCost * adjustedMult;
    pAny += p;
  }
  return {
    picks,
    hitProbability: pAny,
    expectedValue: ev,
    grossPayout: entryCost * topMult,
    payoutMultiplier: topMult,
    correlationRisk: correlationRisk(props),
    playType: "flex",
  };
}

export function optimize({
  selectedProps,
  lineupSize,
  entryCost,
  riskMode,
  maxResults = 50,
  variantsByPropId,
  playType,
  filters,
}: OptimizeParams & { filters?: FilterOptions }): { lineups: Lineup[]; totalGenerated: number; elapsedMs: number } {
  const start = performance.now();
  const lineups: Lineup[] = [];
  let counter = 0;

  // ── Enumerate: combinations × variant assignments × side masks × play types ──
  // PrizePicks rule: demon/goblin variants are MORE-only. We only iterate over
  // "free" positions (standard variant) in the side mask; non-standard
  // positions are pinned to MORE. This shrinks the search space and keeps
  // every emitted lineup actually enterable on PrizePicks.
  for (const combo of combinations(selectedProps, lineupSize)) {
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

// ════════════════════════════════════════════════════════════════════
// Recommendation engine: best lineup at each size + an overall pick
// ════════════════════════════════════════════════════════════════════

export interface SizeRecommendation {
  size: number;
  /** Auto-chosen play type for this size's winning lineup. */
  playType: PlayType;
  best: Lineup | null;          // top lineup of this size
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
    const countPositiveEv = r.lineups.filter((l) => l.expectedValue > 0).length;
    const countAboveMinHit = filters?.minHitProb
      ? r.lineups.filter((l) => l.hitProbability >= filters.minHitProb!).length
      : r.lineups.length;
    bySize.push({
      size,
      playType: best?.playType ?? "power",
      best,
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
