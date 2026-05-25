/**
 * Tunable constants for the heuristic projection model.
 *
 * These were originally hand-picked in `realProjections.ts`. Lifting
 * them here lets both the live model and the offline tuning script
 * (`scripts/tune-heuristic.ts`) share one source of truth.
 *
 * Values updated by tuning runs are committed back here as code.
 *
 * Last tuned: 2026-05-25T05:23:54.309Z
 * * Holdout log-loss: 0.64992 → 0.64508 (Δ -0.00484)
 * Holdout calibration gap: 4.95% → 1.58% (Δ -3.37%)
 */

export const MODEL_CONSTANTS = {
  // ── Variance floor ────────────────────────────────────────────────
  sigmaFloorMultiplier: 0.5,
  sigmaFloorAbsolute: 1.5,

  // ── Adjustment: recent form (last-5 vs season) ────────────────────
  recentFormShiftThresholdSigma: 0.1,
  recentFormConfidence: 0.4,

  // ── Adjustment: vs specific opponent ──────────────────────────────
  vsOppShiftThresholdSigma: 0.1,
  vsOppConfidenceBase: 0.1,
  vsOppConfidencePerGame: 0.05,
  vsOppConfidenceCap: 0.3,

  // ── Adjustment: home / away split ─────────────────────────────────
  homeAwayShiftThresholdSigma: 0.25,
  homeAwayConfidenceBase: 0.15,
  homeAwayConfidencePerSide: 0.02,
  homeAwayConfidenceCap: 0.3,

  // ── Adjustment: days-rest bucket ──────────────────────────────────
  daysRestShiftThresholdSigma: 0.2,
  daysRestConfidenceBase: 0.1,
  daysRestConfidencePerGame: 0.01,
  daysRestConfidenceCap: 0.2,

  // ── pMore clamp ────────────────────────────────────────────────────
  pMoreClampLow: 0.02,
  pMoreClampHigh: 0.9,
} as const;

export type ModelConstants = typeof MODEL_CONSTANTS;
