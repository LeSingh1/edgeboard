/**
 * Isotonic regression via Pool-Adjacent-Violators (PAVA).
 *
 * Input: array of (predicted, hit) pairs where hit ∈ {0, 1}.
 * Output: monotonically non-decreasing step function approximating
 *         P(actual hit | predicted = x).
 *
 * Why isotonic and not Platt scaling: Platt assumes a sigmoid shape.
 * Our heuristic model may miscalibrate in non-monotonic ways at the
 * tails (clamped at 0.02/0.98). PAVA makes no parametric assumption —
 * it just enforces monotonicity, which is the only property we need.
 *
 * Algorithm: sort pairs by predicted, then sweep, maintaining a stack
 * of blocks. Each block has a mean and a weight. When adding a new
 * pair would violate monotonicity (its block's mean is lower than the
 * previous block's mean), merge them. Repeat until no violations.
 *
 * Output is an array of {predicted, corrected} breakpoints. Apply by
 * linear interpolation between adjacent points; extrapolate flat at
 * the endpoints.
 */

export interface CalibrationBreakpoint {
  predicted: number;
  corrected: number;
}

export interface CalibrationModel {
  fittedAt: string;
  /** Number of pairs the model was fit on. */
  trainingSize: number;
  /** Monotonically non-decreasing in `predicted`. */
  breakpoints: CalibrationBreakpoint[];
}

/**
 * Per-oddsType calibration model. Standards, goblins, and demons have
 * materially different residual structures (see `report.json` byOddsType
 * breakout — at the 0.80-0.90 bucket the residuals are −16.7%, −12.6%, −8.8%
 * respectively). A single global curve over-/under-corrects each. We fit one
 * curve per oddsType and route by `prop.oddsType` at apply time.
 *
 * `all` is the global curve kept for fallback (cold-start, unknown oddsType).
 */
export interface MultiOddsCalibrationModel {
  fittedAt: string;
  trainingSize: number;
  all: CalibrationModel;
  standard: CalibrationModel;
  goblin: CalibrationModel;
  demon: CalibrationModel;
}

export type OddsTypeKey = "standard" | "goblin" | "demon";

/**
 * Per-stat × per-oddsType calibration model — the most granular form.
 * Routes by `(stat, oddsType)` with graceful fallback: stat+odds → odds → all.
 *
 * Per-stat residuals diverge by ~4 percentage points (Points −4.5%,
 * Assists −8.3% on the unconditioned model), so per-stat curves
 * materially improve calibration. Combo stats (Pts+Rebs, PRA, …) get
 * their own curves rather than being decomposed, since their combined
 * variance differs from a sum-of-components in non-trivial ways.
 */
export interface PerStatCalibrationModel {
  fittedAt: string;
  trainingSize: number;
  /** Global fallback when stat is unknown or sample too small. */
  all: CalibrationModel;
  /** Per oddsType (cross-stat). Fallback when stat-specific cell is sparse. */
  byOddsType: Record<OddsTypeKey, CalibrationModel>;
  /** Stat → oddsType → curve. The primary path. */
  byStatOdds: Record<string, Record<OddsTypeKey, CalibrationModel>>;
}

/** Pool-Adjacent-Violators isotonic regression. */
export function fitCalibration(
  pairs: Array<{ predicted: number; hit: boolean }>,
): CalibrationModel {
  if (pairs.length === 0) {
    return {
      fittedAt: new Date().toISOString(),
      trainingSize: 0,
      breakpoints: [],
    };
  }

  // Sort by predicted; tie-break by hit (doesn't actually matter, just
  // makes the algorithm deterministic).
  const sorted = [...pairs].sort((a, b) => {
    if (a.predicted !== b.predicted) return a.predicted - b.predicted;
    return Number(a.hit) - Number(b.hit);
  });

  // PAVA — maintain a stack of blocks. Each block = { sumHits, weight, sumPred }
  // Block's mean hit rate = sumHits / weight. Block's mean predicted = sumPred / weight.
  interface Block {
    sumHits: number;
    sumPred: number;
    weight: number;
  }
  const stack: Block[] = [];

  for (const p of sorted) {
    let cur: Block = { sumHits: p.hit ? 1 : 0, sumPred: p.predicted, weight: 1 };
    // Merge with top while the new block's mean ≤ top's mean (violation).
    while (
      stack.length > 0 &&
      stack[stack.length - 1].sumHits / stack[stack.length - 1].weight >=
        cur.sumHits / cur.weight
    ) {
      const top = stack.pop()!;
      cur = {
        sumHits: top.sumHits + cur.sumHits,
        sumPred: top.sumPred + cur.sumPred,
        weight: top.weight + cur.weight,
      };
    }
    stack.push(cur);
  }

  // Convert blocks → breakpoints. Each block contributes one breakpoint at
  // its mean predicted, with corrected = block mean hit rate.
  //
  // Hard clip the corrected value to [0.05, 0.95]. PAVA endpoints are
  // unconstrained — a small first block with a few unlucky misses can
  // produce `corrected=0`, and via the flat-extrapolation apply path that
  // value becomes the output for every input below the first breakpoint.
  // The [0.05, 0.95] band bounds the absolute output to a sane range
  // (matches the model's documented "no certainty beyond 95%" stance) and
  // is monotonicity-safe because it preserves the ordering of the input
  // hit rates.
  const CLIP_LO = 0.05;
  const CLIP_HI = 0.95;
  const breakpoints: CalibrationBreakpoint[] = stack.map((b) => ({
    predicted: b.sumPred / b.weight,
    corrected: Math.max(CLIP_LO, Math.min(CLIP_HI, b.sumHits / b.weight)),
  }));

  // Sanity: monotonicity invariant.
  for (let i = 1; i < breakpoints.length; i++) {
    if (breakpoints[i].corrected < breakpoints[i - 1].corrected - 1e-9) {
      throw new Error(
        `PAVA produced non-monotonic output at index ${i}: ${breakpoints[i - 1].corrected} > ${breakpoints[i].corrected}`,
      );
    }
  }

  return {
    fittedAt: new Date().toISOString(),
    trainingSize: pairs.length,
    breakpoints,
  };
}

/**
 * Apply the calibration model to a raw predicted probability. Linear
 * interpolation between adjacent breakpoints; extrapolates flat at the
 * endpoints (i.e. clamps to the first/last breakpoint's corrected value).
 *
 * Returns the input unchanged if the model has no breakpoints — useful
 * fallback when calibration.json hasn't been written yet.
 */
export function applyCalibrationModel(
  model: CalibrationModel,
  predicted: number,
): number {
  // Output safety clamp — guards against legacy calibration files that
  // were fit before the in-fitter clip and could still have degenerate
  // (0, 0) or (1, 1) endpoints. Cheap defense; never harms correctly-fit
  // curves because their endpoints are already in this range.
  const APPLY_LO = 0.05;
  const APPLY_HI = 0.95;
  const clip = (x: number) => Math.max(APPLY_LO, Math.min(APPLY_HI, x));

  const bp = model.breakpoints;
  if (bp.length === 0) return predicted;
  if (predicted <= bp[0].predicted) return clip(bp[0].corrected);
  if (predicted >= bp[bp.length - 1].predicted) {
    return clip(bp[bp.length - 1].corrected);
  }
  // Binary search for the bracketing breakpoints. Linear scan is fine
  // — typical N is <50 — but binary keeps it cheap if N grows.
  let lo = 0;
  let hi = bp.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bp[mid].predicted <= predicted) lo = mid;
    else hi = mid;
  }
  const left = bp[lo];
  const right = bp[hi];
  const span = right.predicted - left.predicted;
  if (span <= 0) return left.corrected;
  const t = (predicted - left.predicted) / span;
  return left.corrected + t * (right.corrected - left.corrected);
}

/**
 * Fit four calibration curves at once: a global one plus one per oddsType.
 * Pairs without a recognized oddsType contribute to `all` only.
 */
export function fitMultiOddsCalibration(
  pairs: Array<{ predicted: number; hit: boolean; oddsType: OddsTypeKey }>,
): MultiOddsCalibrationModel {
  const buckets: Record<OddsTypeKey, Array<{ predicted: number; hit: boolean }>> = {
    standard: [],
    goblin: [],
    demon: [],
  };
  for (const p of pairs) {
    const slot = buckets[p.oddsType];
    if (slot) slot.push({ predicted: p.predicted, hit: p.hit });
  }
  return {
    fittedAt: new Date().toISOString(),
    trainingSize: pairs.length,
    all: fitCalibration(pairs),
    standard: fitCalibration(buckets.standard),
    goblin: fitCalibration(buckets.goblin),
    demon: fitCalibration(buckets.demon),
  };
}

/** Type guard — distinguishes the new multi-oddsType schema from the legacy
 *  single-curve schema for forward/backward compat in `applyCalibration.ts`. */
export function isMultiOddsCalibrationModel(
  m: CalibrationModel | MultiOddsCalibrationModel,
): m is MultiOddsCalibrationModel {
  return "all" in m && "standard" in m && "goblin" in m && "demon" in m && !("byStatOdds" in m);
}

/** Type guard for the most granular per-stat × per-oddsType schema. */
export function isPerStatCalibrationModel(
  m: CalibrationModel | MultiOddsCalibrationModel | PerStatCalibrationModel,
): m is PerStatCalibrationModel {
  return "byStatOdds" in m && "byOddsType" in m && "all" in m;
}

const ODDS_TYPES: OddsTypeKey[] = ["standard", "goblin", "demon"];

/**
 * Fit the full per-stat × per-oddsType grid plus oddsType and global
 * fallbacks. Stat×odds cells with < `minCellSize` pairs are dropped
 * from `byStatOdds` — the apply path falls back to `byOddsType` for them.
 */
export function fitPerStatCalibration(
  pairs: Array<{ predicted: number; hit: boolean; oddsType: OddsTypeKey; stat: string }>,
  minCellSize = 800,
): PerStatCalibrationModel {
  const all = fitCalibration(pairs);
  const byOddsType: Record<OddsTypeKey, CalibrationModel> = {} as Record<
    OddsTypeKey,
    CalibrationModel
  >;
  for (const ot of ODDS_TYPES) {
    byOddsType[ot] = fitCalibration(pairs.filter((p) => p.oddsType === ot));
  }
  const byStat = new Map<string, typeof pairs>();
  for (const p of pairs) {
    let arr = byStat.get(p.stat);
    if (!arr) {
      arr = [];
      byStat.set(p.stat, arr);
    }
    arr.push(p);
  }
  const byStatOdds: PerStatCalibrationModel["byStatOdds"] = {};
  for (const [stat, statPairs] of byStat) {
    const row: Record<OddsTypeKey, CalibrationModel> = {} as Record<OddsTypeKey, CalibrationModel>;
    let kept = 0;
    for (const ot of ODDS_TYPES) {
      const cell = statPairs.filter((p) => p.oddsType === ot);
      if (cell.length >= minCellSize) {
        row[ot] = fitCalibration(cell);
        kept++;
      }
    }
    if (kept > 0) byStatOdds[stat] = row;
  }
  return {
    fittedAt: new Date().toISOString(),
    trainingSize: pairs.length,
    all,
    byOddsType,
    byStatOdds,
  };
}
