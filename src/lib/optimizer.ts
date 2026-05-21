import type { Prop, PickSide, Lineup, PlayType, RiskMode } from "@/lib/types";

/** Lazy generator: every k-sized subset of arr. */
export function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  if (k > arr.length || k <= 0) return;
  if (k === arr.length) { yield arr; return; }
  const [first, ...rest] = arr;
  for (const c of combinations(rest, k - 1)) yield [first, ...c];
  for (const c of combinations(rest, k)) yield c;
}

/** Every k-pick lineup from props × every over/under combination. */
export function* allLineupShapes(
  props: Prop[],
  k: number,
): Generator<{ props: Prop[]; sides: PickSide[] }> {
  for (const group of combinations(props, k)) {
    for (let mask = 0; mask < (1 << k); mask++) {
      const sides: PickSide[] = group.map((_, i) =>
        ((mask >> i) & 1) ? "more" : "less",
      );
      yield { props: group, sides };
    }
  }
}

/**
 * PrizePicks Power Play multipliers — current, documented in PrizePicks help center.
 *   2-pick: 3×   3-pick: 5×   4-pick: 10×   5-pick: 20×   6-pick: 25×
 *
 * Note: 3-pick was 6× in earlier eras and 6-pick has been 37.5× / 30× / 25× at
 * various points. 25× is current standard. Adjust here if PrizePicks changes the
 * matrix — it's a single source of truth.
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
 *   - demon:    × 1.25 (higher payout, harder hit)
 *   - goblin:   × 0.85 (lower payout, easier hit)
 *   - standard: × 1.00
 */
const ODDS_FACTOR: Record<Prop["oddsType"], number> = {
  standard: 1.0,
  demon: 1.25,
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

export function correlationRisk(props: Prop[]): "low" | "medium" | "high" {
  const players = props.map((p) => p.playerName);
  if (new Set(players).size < players.length) return "high";
  const games = props.map((p) => `${p.team}-${p.opponent}-${p.gameTime}`);
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
      const sameGame =
        `${a.team}-${a.opponent}-${a.gameTime}` ===
        `${b.team}-${b.opponent}-${b.gameTime}`;
      if (a.playerName === b.playerName || sameGame) correlatedPairs++;
    }
  }
  return pIndependent * (1 - rho * (correlatedPairs / totalPairs));
}

export interface OptimizeParams {
  selectedProps: Prop[];
  lineupSize: number;
  playType: PlayType;
  entryCost: number;
  riskMode: RiskMode;
  maxResults?: number;
}

export interface FilterOptions {
  minHitProb?: number;   // 0..1
  minEv?: number;        // absolute dollar EV
}

export function optimize({
  selectedProps,
  lineupSize,
  playType,
  entryCost,
  riskMode,
  maxResults = 50,
  filters,
}: OptimizeParams & { filters?: FilterOptions }): { lineups: Lineup[]; totalGenerated: number; elapsedMs: number } {
  const start = performance.now();
  const lineups: Lineup[] = [];
  let counter = 0;

  for (const shape of allLineupShapes(selectedProps, lineupSize)) {
    counter++;
    const picks = shape.props.map((prop, i) => ({
      prop,
      side: shape.sides[i],
      probability: shape.sides[i] === "more" ? prop.pMore : prop.pLess,
    }));
    const probs = picks.map((p) => p.probability);
    const oddsFactor = oddsPayoutFactor(shape.props);

    let hitProbability: number;
    let grossPayout: number;
    let expectedValue: number;
    let payoutMultiplier: number;

    if (playType === "power") {
      const pIndependent = probs.reduce((a, b) => a * b, 1);
      hitProbability = applyCorrelationPenalty(pIndependent, shape.props);
      const baseMult = POWER_MULTIPLIERS[lineupSize] ?? 0;
      payoutMultiplier = baseMult * oddsFactor;
      grossPayout = entryCost * payoutMultiplier;
      expectedValue = hitProbability * grossPayout - entryCost;
    } else {
      const dist = poissonBinomial(probs);
      const tiers = FLEX_PAYOUT_TABLES[lineupSize] ?? [];
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
      hitProbability = pAny;
      payoutMultiplier = topMult;
      grossPayout = entryCost * topMult;
      expectedValue = ev;
    }

    const risk = correlationRisk(shape.props);
    lineups.push({
      id: `lineup-${start.toFixed(0)}-${counter}`,
      rank: 0,
      picks,
      hitProbability,
      expectedValue,
      grossPayout,
      netProfit: grossPayout - entryCost,
      payoutMultiplier,
      correlationRisk: risk,
      playType,
      entryCost,
    });
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
  const top = filtered.slice(0, maxResults).map((l, i) => ({ ...l, rank: i + 1 }));

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
  playType: PlayType;
  best: Lineup | null;          // top lineup of this size/playType
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
 * given the user's picks, play type, and filters. Then pick a top recommendation
 * by mode:
 *   safe       → highest hit %
 *   balanced   → highest EV among slips with ≥ 10% hit prob
 *   aggressive → highest EV regardless of hit prob
 */
export function recommendLineups({
  selectedProps,
  entryCost,
  playType,
  riskMode,
  filters,
}: {
  selectedProps: Prop[];
  entryCost: number;
  playType: PlayType;
  riskMode: RiskMode;
  filters?: FilterOptions;
}): RecommendResult {
  const N = selectedProps.length;
  const bySize: SizeRecommendation[] = [];

  const validSizes: number[] = [];
  for (let k = 2; k <= Math.min(N, 6); k++) {
    // Flex only supports 3+
    if (playType === "flex" && k < 3) continue;
    validSizes.push(k);
  }

  for (const size of validSizes) {
    const r = optimize({
      selectedProps,
      lineupSize: size,
      playType,
      entryCost,
      riskMode,
      maxResults: 1,
      filters,
    });
    const best = r.lineups[0] ?? null;
    // Recount across the full unfiltered set
    const unfiltered = optimize({
      selectedProps,
      lineupSize: size,
      playType,
      entryCost,
      riskMode,
      maxResults: 100000,
    });
    const countPositiveEv = unfiltered.lineups.filter((l) => l.expectedValue > 0).length;
    const countAboveMinHit = filters?.minHitProb
      ? unfiltered.lineups.filter((l) => l.hitProbability >= filters.minHitProb!).length
      : unfiltered.lineups.length;
    bySize.push({
      size,
      playType,
      best,
      totalEvaluated: unfiltered.totalGenerated,
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
