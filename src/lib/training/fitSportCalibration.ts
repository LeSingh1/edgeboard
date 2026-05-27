/**
 * Per-sport calibration fitter — uniform wrapper around the existing
 * isotonic (PAVA) fitter in `lib/backtest/fitCalibration`.
 *
 * The backtest module already implements PAVA and the per-stat × per-oddsType
 * grid, but its output shape (`PerStatCalibrationModel` with nested
 * `CalibrationModel.breakpoints[]`) doesn't match the shared
 * `CalibrationTable` schema the training pipeline persists and the runtime
 * apply path reads. This wrapper bridges the two:
 *
 *  - groups `ScoredPick[]` by `${stat}|${oddsType}`,
 *  - drops buckets below `minBucketSize` (the floor that protects against
 *    fitting noise on sparse cells — same intent as `fitPerStatCalibration`'s
 *    `minCellSize` arg, lifted out so callers control it per sport),
 *  - calls `fitCalibration` per surviving bucket and rewrites the
 *    `breakpoints[]` into the flat `{x[], y[]}` form `CalibrationTable` uses.
 *
 * We deliberately do NOT carry over the global / per-oddsType fallback levels
 * from `PerStatCalibrationModel` — the apply-path for `CalibrationTable`
 * is a single-level lookup keyed by `${stat}|${oddsType}`, and adding
 * fallbacks here would silently change the on-disk schema. Sports whose
 * datasets are too small for stat-level cells will simply have an empty
 * `buckets` object; the apply layer is expected to no-op in that case.
 */

import { fitCalibration } from "@/lib/backtest/fitCalibration";
import type { ScoredPick } from "@/lib/backtest/aggregate";
import type { CalibrationTable } from "@/lib/sports/types";

export interface FitOpts {
  /** Minimum picks per (stat, oddsType) bucket. Below this → skip the bucket. */
  minBucketSize: number;
}

export function fitSportCalibration(
  picks: ScoredPick[],
  opts: FitOpts,
): CalibrationTable {
  const grouped = new Map<string, ScoredPick[]>();
  for (const p of picks) {
    const key = `${p.stat}|${p.oddsType}`;
    const arr = grouped.get(key);
    if (arr) arr.push(p);
    else grouped.set(key, [p]);
  }

  const buckets: CalibrationTable["buckets"] = {};
  for (const [key, bucketPicks] of grouped) {
    if (bucketPicks.length < opts.minBucketSize) continue;

    const pairs = bucketPicks.map((p) => ({
      predicted: p.predictedPMore,
      hit: p.hit,
    }));
    const model = fitCalibration(pairs);
    if (model.breakpoints.length === 0) continue;

    buckets[key] = {
      x: model.breakpoints.map((b) => b.predicted),
      y: model.breakpoints.map((b) => b.corrected),
      sampleSize: bucketPicks.length,
    };
  }

  return { buckets };
}
