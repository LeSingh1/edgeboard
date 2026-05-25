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
  const breakpoints: CalibrationBreakpoint[] = stack.map((b) => ({
    predicted: b.sumPred / b.weight,
    corrected: b.sumHits / b.weight,
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
  const bp = model.breakpoints;
  if (bp.length === 0) return predicted;
  if (predicted <= bp[0].predicted) return bp[0].corrected;
  if (predicted >= bp[bp.length - 1].predicted) {
    return bp[bp.length - 1].corrected;
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
