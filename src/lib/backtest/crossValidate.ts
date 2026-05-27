/**
 * K-fold cross-validation for the calibration fit.
 *
 * The production calibration is fit on 100% of the data — that's the best
 * single estimate. K-fold CV doesn't replace it; instead it tells us how
 * STABLE the fit is. For each fold k:
 *   1. Train an isotonic curve on the other (k-1) folds.
 *   2. Apply that curve to the held-out fold.
 *   3. Record per-bucket residuals on the held-out fold.
 *
 * Average and std-dev across folds give us confidence intervals on
 * calibration. Wide spread = the curve is overfitting to noise; narrow
 * spread = robust.
 */

import { fitCalibration, applyCalibrationModel } from "@/lib/backtest/fitCalibration";

interface CVPair {
  predicted: number;
  hit: boolean;
}

export interface CVBucketStat {
  range: string;
  /** Mean residual across folds (held-out, post-calibration). */
  meanResidual: number;
  /** Standard deviation of residual across folds. */
  stdResidual: number;
  /** Per-fold sample sizes. */
  foldNs: number[];
}

export interface CVReport {
  folds: number;
  totalPairs: number;
  /** Per-bucket residual statistics across folds. */
  buckets: CVBucketStat[];
  /** Global mean & std of residual (calibrated, held-out). */
  globalMeanResidual: number;
  globalStdResidual: number;
}

const RANGES: Array<{ lo: number; hi: number; label: string }> = [
  { lo: 0.5, hi: 0.6, label: "0.50-0.60" },
  { lo: 0.6, hi: 0.7, label: "0.60-0.70" },
  { lo: 0.7, hi: 0.8, label: "0.70-0.80" },
  { lo: 0.8, hi: 0.9, label: "0.80-0.90" },
  { lo: 0.9, hi: 1.01, label: "0.90-1.00" },
];

/** Deterministic Mulberry32 PRNG so CV is reproducible. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function crossValidateCalibration(
  pairs: CVPair[],
  folds = 5,
  seed = 17,
): CVReport {
  if (pairs.length < folds * 200) {
    // Not enough data to split meaningfully — return a stub.
    return {
      folds: 0,
      totalPairs: pairs.length,
      buckets: [],
      globalMeanResidual: 0,
      globalStdResidual: 0,
    };
  }

  const shuffled = shuffle(pairs, seed);
  const foldSize = Math.floor(shuffled.length / folds);

  // For each bucket × fold, hold the post-calibration residual on the held-out slice.
  const perBucketFoldResiduals: number[][] = RANGES.map(() => []);
  const perBucketFoldNs: number[][] = RANGES.map(() => []);
  const globalResiduals: number[] = [];

  for (let f = 0; f < folds; f++) {
    const heldOutStart = f * foldSize;
    const heldOutEnd = f === folds - 1 ? shuffled.length : heldOutStart + foldSize;
    const heldOut = shuffled.slice(heldOutStart, heldOutEnd);
    const trainSet = [...shuffled.slice(0, heldOutStart), ...shuffled.slice(heldOutEnd)];
    const model = fitCalibration(trainSet);

    let foldHits = 0;
    let foldCalibratedSum = 0;
    let foldN = 0;
    for (let bi = 0; bi < RANGES.length; bi++) {
      const range = RANGES[bi];
      let bucketHits = 0;
      let bucketCalibratedSum = 0;
      let bucketN = 0;
      for (const p of heldOut) {
        const calibrated = applyCalibrationModel(model, p.predicted);
        if (calibrated < range.lo || calibrated >= range.hi) continue;
        if (p.hit) bucketHits++;
        bucketCalibratedSum += calibrated;
        bucketN++;
      }
      if (bucketN > 0) {
        const meanCal = bucketCalibratedSum / bucketN;
        const actual = bucketHits / bucketN;
        perBucketFoldResiduals[bi].push(actual - meanCal);
        perBucketFoldNs[bi].push(bucketN);
      } else {
        perBucketFoldNs[bi].push(0);
      }
      foldHits += bucketHits;
      foldCalibratedSum += bucketCalibratedSum;
      foldN += bucketN;
    }
    if (foldN > 0) {
      globalResiduals.push(foldHits / foldN - foldCalibratedSum / foldN);
    }
  }

  const buckets: CVBucketStat[] = RANGES.map((r, bi) => {
    const arr = perBucketFoldResiduals[bi];
    const mean = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const variance =
      arr.length > 1
        ? arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1)
        : 0;
    return {
      range: r.label,
      meanResidual: mean,
      stdResidual: Math.sqrt(variance),
      foldNs: perBucketFoldNs[bi],
    };
  });

  const gMean =
    globalResiduals.length > 0
      ? globalResiduals.reduce((a, b) => a + b, 0) / globalResiduals.length
      : 0;
  const gVar =
    globalResiduals.length > 1
      ? globalResiduals.reduce((a, b) => a + (b - gMean) ** 2, 0) /
        (globalResiduals.length - 1)
      : 0;

  return {
    folds,
    totalPairs: pairs.length,
    buckets,
    globalMeanResidual: gMean,
    globalStdResidual: Math.sqrt(gVar),
  };
}

// ════════════════════════════════════════════════════════════════════
// Walk-forward validation — train on past, evaluate on next month.
// Detects seasonal drift that random CV would miss (e.g., the model
// works fine Nov–Mar but blows up in playoffs).
// ════════════════════════════════════════════════════════════════════

export interface WalkForwardMonthStat {
  /** YYYY-MM */
  month: string;
  trainSize: number;
  evalSize: number;
  /** Mean predicted prob across evaluated picks (after calibration trained
   *  on prior months). */
  meanPredicted: number;
  /** Actual hit rate in this month. */
  actualHitRate: number;
  /** actualHitRate − meanPredicted. Sign indicates direction of bias. */
  residual: number;
}

export interface WalkForwardReport {
  generatedAt: string;
  months: WalkForwardMonthStat[];
  /** Mean absolute residual across months — overall drift signal. */
  meanAbsResidual: number;
}

interface DatedPair extends CVPair {
  /** ISO date — required for temporal ordering. */
  date: string;
}

/** Year-month key, e.g. "2025-11" for November 2025. */
function ymKey(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * For each month with ≥ `minMonthSize` evaluation samples and ≥
 * `minTrainSize` prior-month samples: train calibration on EVERYTHING
 * before that month, apply to the month's pairs, record bucketed residual.
 *
 * Cumulative training window grows with each month (expanding origin),
 * not sliding — matches how the live pipeline accumulates data over time.
 */
export function walkForwardValidate(
  pairs: DatedPair[],
  minTrainSize = 5000,
  minMonthSize = 500,
): WalkForwardReport {
  // Bucket by month
  const byMonth = new Map<string, DatedPair[]>();
  for (const p of pairs) {
    const key = ymKey(p.date);
    if (!key) continue;
    let arr = byMonth.get(key);
    if (!arr) {
      arr = [];
      byMonth.set(key, arr);
    }
    arr.push(p);
  }
  const months = [...byMonth.keys()].sort();

  const out: WalkForwardMonthStat[] = [];
  const train: CVPair[] = [];
  for (const m of months) {
    const monthPairs = byMonth.get(m)!;
    if (train.length >= minTrainSize && monthPairs.length >= minMonthSize) {
      const model = fitCalibration(train);
      let predSum = 0;
      let hits = 0;
      for (const p of monthPairs) {
        const cal = applyCalibrationModel(model, p.predicted);
        predSum += cal;
        if (p.hit) hits++;
      }
      const meanPredicted = predSum / monthPairs.length;
      const actualHitRate = hits / monthPairs.length;
      out.push({
        month: m,
        trainSize: train.length,
        evalSize: monthPairs.length,
        meanPredicted,
        actualHitRate,
        residual: actualHitRate - meanPredicted,
      });
    }
    // Accumulate after evaluating, so the next month sees this month as
    // part of its training set.
    for (const p of monthPairs) train.push({ predicted: p.predicted, hit: p.hit });
  }
  const meanAbsResidual =
    out.length > 0 ? out.reduce((a, b) => a + Math.abs(b.residual), 0) / out.length : 0;
  return { generatedAt: new Date().toISOString(), months: out, meanAbsResidual };
}

