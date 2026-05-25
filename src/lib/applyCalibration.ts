/**
 * Live-side calibration application.
 *
 * Loads `data/backtest/calibration.json` at first request (server-side,
 * cached in memory for the process lifetime). When `realProjections.ts`
 * finishes computing a pMore, it routes the value through `calibrate()` /
 * `calibrateSync()` (with the prop's oddsType) to get the corrected version.
 *
 * Supports two on-disk schemas for forward/backward compat:
 *   - Legacy: `{ breakpoints, trainingSize, fittedAt }` — one global curve
 *   - Current: `{ all, standard, goblin, demon, ... }` — per-oddsType curves
 *
 * Falls back to the input unchanged if the file doesn't exist, the model
 * is empty, or the `DISABLE_CALIBRATION=1` env kill-switch is set.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  applyCalibrationModel,
  isMultiOddsCalibrationModel,
  type CalibrationModel,
  type MultiOddsCalibrationModel,
  type OddsTypeKey,
} from "@/lib/backtest/fitCalibration";

const CALIBRATION_PATH = path.join(process.cwd(), "data", "backtest", "calibration.json");

type LoadedModel = CalibrationModel | MultiOddsCalibrationModel;

let cached: LoadedModel | null | undefined; // undefined = not yet attempted, null = tried but failed
let pendingLoad: Promise<void> | null = null;

async function loadCalibration(): Promise<void> {
  try {
    const raw = await fs.readFile(CALIBRATION_PATH, "utf8");
    cached = JSON.parse(raw) as LoadedModel;
  } catch {
    cached = null;
  }
}

/** Reset the in-memory cache. Useful if the user re-ran the backtest and
 *  wants the live process to pick up the new calibration without restart. */
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

function pickCurve(model: LoadedModel, oddsType?: OddsTypeKey): CalibrationModel {
  if (!isMultiOddsCalibrationModel(model)) return model;
  if (oddsType && model[oddsType].breakpoints.length > 0) return model[oddsType];
  return model.all;
}

function isDisabled(): boolean {
  return process.env.DISABLE_CALIBRATION === "1";
}

/** Async calibrator. Routes by oddsType when the loaded model supports it. */
export async function calibrate(predicted: number, oddsType?: OddsTypeKey): Promise<number> {
  if (isDisabled()) return predicted;
  const model = await getCalibration();
  if (!model) return predicted;
  return applyCalibrationModel(pickCurve(model, oddsType), predicted);
}

/** Synchronous fast-path. Returns the input unchanged if calibration hasn't
 *  been loaded yet — callers that care should `await getCalibration()` once
 *  at startup to warm the cache. */
export function calibrateSync(predicted: number, oddsType?: OddsTypeKey): number {
  if (isDisabled()) return predicted;
  if (cached === undefined || cached === null) return predicted;
  return applyCalibrationModel(pickCurve(cached, oddsType), predicted);
}
