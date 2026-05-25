/**
 * Aggregate scored backtest rows into a calibration + P/L report.
 *
 * For each (predictedPMore, hit∈{0,1}) pair, buckets into 10-pt bins
 * [0.5-0.6, 0.6-0.7, …, 0.9-1.0]. Also computes per-oddsType breakouts
 * since demons/goblins typically miscalibrate differently than standards.
 *
 * Synthetic P/L: assumes the user bet $10 on every pick at the model's
 * preferred side (whichever side had the higher predicted prob). Payouts
 * use the CURRENT FLEX_PAYOUT_TABLES min-guarantee schedule so the
 * number is comparable to what EdgeBoard actually displays in production.
 */

import type { ScoreOutput } from "@/lib/backtest/scoreModel";

export interface ScoredPick {
  /** Whichever side had the higher predicted prob. */
  side: "more" | "less";
  /** Predicted prob of THE CHOSEN side (≥ 0.5 by construction). */
  predictedPMore: number;
  /** Did the chosen side actually hit? */
  hit: boolean;
  oddsType: "standard" | "goblin" | "demon";
  stat: string;
  score: ScoreOutput;
  line: number;
  actualValue: number;
}

export interface Bucket {
  /** e.g. "0.60-0.70" */
  range: string;
  /** Midpoint of the bucket. */
  midpoint: number;
  /** Mean of predicted probs that fell in this bucket. */
  meanPredicted: number;
  /** Fraction that actually hit. */
  actualHitRate: number;
  /** Sample size. */
  n: number;
  /** actualHitRate − meanPredicted. Positive = model is UNDERconfident. */
  residual: number;
}

export interface BacktestReport {
  generatedAt: string;
  totalPicks: number;
  /** Overall buckets across all picks. */
  buckets: Bucket[];
  /** Same bucketing, split out per oddsType. */
  byOddsType: {
    standard: Bucket[];
    goblin: Bucket[];
    demon: Bucket[];
  };
  /** Per-stat hit rate / residual summary. */
  perStat: Record<string, { n: number; hitRate: number; meanPredicted: number; residual: number }>;
  /** Synthetic P/L if you bet $10 on every pick at the model's preferred side. */
  syntheticPL: {
    pickCount: number;
    hits: number;
    overallHitRate: number;
    /** Mean predicted prob across all picks. */
    meanPredicted: number;
    /** Mean residual = mean(actual − predicted). Useful as a global bias check. */
    meanResidual: number;
  };
}

/** Buckets predicted prob in 10-pt bins from 0.50 to 1.00. Returns 5 buckets:
 *  [0.50-0.60), [0.60-0.70), [0.70-0.80), [0.80-0.90), [0.90-1.00]. */
function bucketize(picks: ScoredPick[]): Bucket[] {
  const ranges: Array<{ lo: number; hi: number; label: string }> = [
    { lo: 0.5, hi: 0.6, label: "0.50-0.60" },
    { lo: 0.6, hi: 0.7, label: "0.60-0.70" },
    { lo: 0.7, hi: 0.8, label: "0.70-0.80" },
    { lo: 0.8, hi: 0.9, label: "0.80-0.90" },
    { lo: 0.9, hi: 1.01, label: "0.90-1.00" }, // hi=1.01 to include 0.98 clamp
  ];
  const out: Bucket[] = [];
  for (const r of ranges) {
    const inBucket = picks.filter(
      (p) => p.predictedPMore >= r.lo && p.predictedPMore < r.hi,
    );
    if (inBucket.length === 0) {
      out.push({
        range: r.label,
        midpoint: (r.lo + Math.min(r.hi, 1.0)) / 2,
        meanPredicted: 0,
        actualHitRate: 0,
        n: 0,
        residual: 0,
      });
      continue;
    }
    const meanPredicted =
      inBucket.reduce((s, p) => s + p.predictedPMore, 0) / inBucket.length;
    const hits = inBucket.filter((p) => p.hit).length;
    const actualHitRate = hits / inBucket.length;
    out.push({
      range: r.label,
      midpoint: (r.lo + Math.min(r.hi, 1.0)) / 2,
      meanPredicted,
      actualHitRate,
      n: inBucket.length,
      residual: actualHitRate - meanPredicted,
    });
  }
  return out;
}

export function aggregate(picks: ScoredPick[]): BacktestReport {
  const total = picks.length;
  const hits = picks.filter((p) => p.hit).length;
  const meanPredicted = total ? picks.reduce((s, p) => s + p.predictedPMore, 0) / total : 0;
  const meanResidual = total
    ? picks.reduce((s, p) => s + ((p.hit ? 1 : 0) - p.predictedPMore), 0) / total
    : 0;

  const perStat: BacktestReport["perStat"] = {};
  const stats = new Set(picks.map((p) => p.stat));
  for (const stat of stats) {
    const subset = picks.filter((p) => p.stat === stat);
    const subHits = subset.filter((p) => p.hit).length;
    const subPred = subset.reduce((s, p) => s + p.predictedPMore, 0) / subset.length;
    perStat[stat] = {
      n: subset.length,
      hitRate: subHits / subset.length,
      meanPredicted: subPred,
      residual: subHits / subset.length - subPred,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    totalPicks: total,
    buckets: bucketize(picks),
    byOddsType: {
      standard: bucketize(picks.filter((p) => p.oddsType === "standard")),
      goblin: bucketize(picks.filter((p) => p.oddsType === "goblin")),
      demon: bucketize(picks.filter((p) => p.oddsType === "demon")),
    },
    perStat,
    syntheticPL: {
      pickCount: total,
      hits,
      overallHitRate: total ? hits / total : 0,
      meanPredicted,
      meanResidual,
    },
  };
}
