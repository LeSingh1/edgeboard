// src/lib/sports/soccer/calibrate.ts
//
// Operator rule: "if the World Cup isn't trained, don't bet on it at all."
//
// The live World Cup projection (espnLiveProjection) is a raw game-log model.
// The TRAINED soccer model is the 16M-sample isotonic calibration in
// data/training/artifacts/soccer/calibration.json, keyed by `${stat}|${oddsType}`.
// It only covers some stats, all `standard`:
//   Goals, Assists, Fouls(+Committed/Suffered), Goal+Assist, Goals+Assists,
//   Goalie Saves, Saves, Goals Allowed.
// It does NOT cover Shots or SOT, and has no goblin/demon curves.
//
// So a World Cup prop is bettable ONLY when the trained model has a bucket for its
// exact stat|oddsType. Untrained stats (Shots, SOT, Offsides, Clean Sheets) and
// untrained rungs (goblin/demon) are excluded — the no-mock gate drops them. The
// trained stats get the calibration applied to the bet-side probability so the
// surfaced number is the model's learned hit-rate, not a raw z-score.
import type { Prop } from "@/lib/types";
import type { SportArtifacts } from "@/lib/sports/types";
import type { ProjectionResult } from "@/lib/realProjections";
import { applyCalibrationModel } from "@/lib/backtest/fitCalibration";

// Live prop stat label → trained-bucket stat label (the training pipeline used a
// slightly different name for fouls-drawn). Everything else matches by name.
const STAT_ALIAS: Record<string, string> = {
  "Fouls Drawn": "Fouls Suffered",
};

// A sane isotonic nudge corrects a probability; it must not swing a near-coinflip
// into a near-lock. Cap the absolute correction (same spirit as the NBA path).
const MAX_SHIFT = 0.25;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function calibrateSoccer(
  raw: ProjectionResult,
  prop: Prop,
  artifacts: SportArtifacts,
): ProjectionResult {
  if (!raw.available) return raw;

  const buckets = artifacts.calibration?.buckets;
  if (!buckets) {
    return { available: false, reason: "Soccer model not loaded — untrained, excluded" };
  }
  const statName = STAT_ALIAS[prop.statType] ?? prop.statType;
  const bucket = buckets[`${statName}|${prop.oddsType}`];
  if (!bucket || !bucket.x?.length || bucket.x.length !== bucket.y?.length) {
    return {
      available: false,
      reason: `World Cup model not trained for "${prop.statType}" (${prop.oddsType}) — excluded`,
    };
  }

  // Calibrate the bet-side probability (the favored side), matching the NBA path.
  const model = {
    breakpoints: bucket.x.map((x, i) => ({ predicted: x, corrected: bucket.y[i] })),
    fittedAt: "",
    trainingSize: bucket.sampleSize,
  };
  const preferMore = raw.pMore >= raw.pLess;
  const chosen = preferMore ? raw.pMore : raw.pLess;
  const calibrated = applyCalibrationModel(model, chosen);
  const bounded = Math.max(chosen - MAX_SHIFT, Math.min(chosen + MAX_SHIFT, calibrated));
  const pMore = preferMore ? bounded : 1 - bounded;

  return {
    ...raw,
    pMore: r3(pMore),
    pLess: r3(1 - pMore),
    modelVersion: "soccer-trained-v2",
    source: `${raw.source} · trained-v2 calibration`,
  };
}
