/**
 * Tunable constants for the heuristic projection model.
 *
 * These were originally hand-picked in `realProjections.ts`. Lifting
 * them here lets both the live model and the offline tuning script
 * (`scripts/tune-heuristic.ts`) share one source of truth.
 *
 * Values updated by tuning runs are committed back here as code.
 *
 * Last tuned: 2026-05-25T20:25:45.675Z
 * * Holdout log-loss: 0.64037 → 0.63995 (Δ -0.00042)
 * Holdout calibration gap: 1.34% → 1.19% (Δ -0.15%)
 */

export const MODEL_CONSTANTS = {
  // ── Variance floor ────────────────────────────────────────────────
  sigmaFloorMultiplier: 0.4,
  sigmaFloorAbsolute: 0.25,

  // ── Base projection: recency blend ────────────────────────────────
  // The base mean blends an equal-weighted mean of all games with a
  // recency-weighted (exponential) mean, because recent games predict the
  // next game better than season-old ones. recencyBlend is the weight on the
  // equal-weighted mean (1 - recencyBlend goes to the recency mean);
  // recencyHalfLife is the EWMA half-life in games. Validated by a walk-forward
  // backtest on 1,165 real NBA player-game predictions: this blend cut held-out
  // log-loss 0.6677 -> 0.6636 and Brier 0.2369 -> 0.2354 vs a pure equal-weight
  // mean, for ~0.9pp of raw accuracy. (A modest, honest calibration gain — not
  // a magic accuracy boost; single-game outcomes are mostly noise.)
  recencyBlend: 0.5,
  recencyHalfLife: 8,

  // ── Adjustment: recent form (last-5 vs season) ────────────────────
  recentFormShiftThresholdSigma: 0.1,
  recentFormConfidence: 0.3,

  // ── Adjustment: vs specific opponent ──────────────────────────────
  vsOppShiftThresholdSigma: 0.3,
  vsOppConfidenceBase: 0.1,
  vsOppConfidencePerGame: 0.05,
  vsOppConfidenceCap: 0.3,

  // ── Adjustment: home / away split ─────────────────────────────────
  homeAwayShiftThresholdSigma: 0.3,
  homeAwayConfidenceBase: 0.15,
  homeAwayConfidencePerSide: 0.02,
  homeAwayConfidenceCap: 0.3,

  // ── Adjustment: days-rest bucket ──────────────────────────────────
  daysRestShiftThresholdSigma: 0.2,
  daysRestConfidenceBase: 0.1,
  daysRestConfidencePerGame: 0.01,
  daysRestConfidenceCap: 0.2,

  // ── Adjustment: opponent defensive rating ─────────────────────────
  defenseRatingShiftThresholdSigma: 0.05,
  defenseRatingConfidenceBase: 0.15,
  defenseRatingConfidencePer30Games: 0.05,
  defenseRatingConfidenceCap: 0.6,

  // ── Adjustment: playoff vs regular-season split ───────────────────
  playoffShiftThresholdSigma: 0.1,
  playoffConfidenceBase: 0.25,
  playoffConfidencePerGame: 0.04,
  playoffConfidenceCap: 0.4,

  // ── Adjustment: breakout-rate context signal ──────────────────────
  breakoutConfidence: 0.3,
  breakoutShiftSigmaScale: 0.5,

  // ── Adjustment: game-script / blowout-context residual ────────────
  /** Min |margin| to even fire the signal — sub-this is "close" and the
   *  observed residuals are tiny noise. We still let the close-bucket fire
   *  but with reduced confidence; tune via the confidence scalars below. */
  gameScriptMinMargin: 4,
  /** Bucket sample threshold below which we skip the lookup. */
  gameScriptMinSample: 100,
  /** Confidence applied to the bucket's mean residual. Conservative until
   *  the signal proves itself in the backtest. */
  gameScriptConfidence: 0.5,

  // ── pMore clamp ────────────────────────────────────────────────────
  pMoreClampLow: 0.1,
  pMoreClampHigh: 0.9,
} as const;

export type ModelConstants = typeof MODEL_CONSTANTS;
