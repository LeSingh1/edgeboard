/**
 * Live-side calibration application.
 *
 * Loads `data/backtest/calibration.json` lazily on first request and
 * caches in memory for the process lifetime. `realProjections.ts`
 * routes every NBA/WNBA pMore through `calibrate(predicted, oddsType, stat)`.
 *
 * Three on-disk schemas are supported for forward/backward compat:
 *   1. Legacy single-curve `{ breakpoints, trainingSize, fittedAt }`
 *   2. Per-oddsType `{ all, standard, goblin, demon }`
 *   3. Per-stat × per-oddsType `{ all, byOddsType, byStatOdds }`
 *
 * Schema 3 falls back: stat+odds curve → oddsType curve → all curve.
 *
 * Kill-switch: `DISABLE_CALIBRATION=1` in server env.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  applyCalibrationModel,
  isMultiOddsCalibrationModel,
  isPerStatCalibrationModel,
  type CalibrationModel,
  type MultiOddsCalibrationModel,
  type OddsTypeKey,
  type PerStatCalibrationModel,
} from "@/lib/backtest/fitCalibration";

const CALIBRATION_PATH = path.join(process.cwd(), "data", "backtest", "calibration.json");

type LoadedModel = CalibrationModel | MultiOddsCalibrationModel | PerStatCalibrationModel;

// Cache state — module-level. Source edits trigger HMR re-eval which resets.
let cached: LoadedModel | null | undefined;
let pendingLoad: Promise<void> | null = null;

async function loadCalibration(): Promise<void> {
  try {
    const raw = await fs.readFile(CALIBRATION_PATH, "utf8");
    cached = JSON.parse(raw) as LoadedModel;
  } catch {
    cached = null;
  }
}

export function resetCalibrationCache(): void {
  cached = undefined;
  pendingLoad = null;
}

export async function getCalibration(): Promise<LoadedModel | null> {
  if (cached !== undefined) return cached;
  if (!pendingLoad) pendingLoad = loadCalibration();
  await pendingLoad;
  return cached ?? null;
}

function pickCurve(
  model: LoadedModel,
  oddsType?: OddsTypeKey,
  stat?: string,
): CalibrationModel {
  if (isPerStatCalibrationModel(model)) {
    if (stat && oddsType) {
      const row = model.byStatOdds[stat];
      if (row && row[oddsType] && row[oddsType].breakpoints.length > 0) {
        return row[oddsType];
      }
    }
    if (oddsType && model.byOddsType[oddsType]?.breakpoints.length > 0) {
      return model.byOddsType[oddsType];
    }
    return model.all;
  }
  if (isMultiOddsCalibrationModel(model)) {
    if (oddsType && model[oddsType].breakpoints.length > 0) return model[oddsType];
    return model.all;
  }
  return model;
}

function isDisabled(): boolean {
  return process.env.DISABLE_CALIBRATION === "1";
}

export async function calibrate(
  predicted: number,
  oddsType?: OddsTypeKey,
  stat?: string,
): Promise<number> {
  if (isDisabled()) return predicted;
  const model = await getCalibration();
  if (!model) return predicted;
  return applyCalibrationModel(pickCurve(model, oddsType, stat), predicted);
}

export function calibrateSync(
  predicted: number,
  oddsType?: OddsTypeKey,
  stat?: string,
): number {
  if (isDisabled()) return predicted;
  if (cached === undefined || cached === null) return predicted;
  return applyCalibrationModel(pickCurve(cached, oddsType, stat), predicted);
}
