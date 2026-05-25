/**
 * Live-side calibration application.
 *
 * Loads `data/backtest/calibration.json` at first request (server-side,
 * cached in memory for the process lifetime). When `realProjections.ts`
 * finishes computing a pMore, it can route the value through `calibrate()`
 * to get the corrected version. Falls back to the input unchanged if the
 * file doesn't exist yet — graceful no-op until the user runs the
 * backtest script for the first time.
 *
 * Behind a feature flag (`useSettingsStore.calibrationEnabled`) so the
 * blast radius of a bad fit is zero by default.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  applyCalibrationModel,
  type CalibrationModel,
} from "@/lib/backtest/fitCalibration";

const CALIBRATION_PATH = path.join(process.cwd(), "data", "backtest", "calibration.json");

let cached: CalibrationModel | null | undefined; // undefined = not yet attempted, null = tried but failed
let pendingLoad: Promise<void> | null = null;

async function loadCalibration(): Promise<void> {
  try {
    const raw = await fs.readFile(CALIBRATION_PATH, "utf8");
    cached = JSON.parse(raw) as CalibrationModel;
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

/**
 * Read the cached calibration model. Lazily loads from disk on first
 * call. Subsequent calls are synchronous-equivalent (the promise
 * resolves with the cached value).
 */
export async function getCalibration(): Promise<CalibrationModel | null> {
  if (cached !== undefined) return cached;
  if (!pendingLoad) pendingLoad = loadCalibration();
  await pendingLoad;
  return cached ?? null;
}

/**
 * Async calibrator. Returns the corrected pMore, or the input unchanged
 * if no calibration model is present.
 */
export async function calibrate(predicted: number): Promise<number> {
  const model = await getCalibration();
  if (!model) return predicted;
  return applyCalibrationModel(model, predicted);
}

/** Synchronous fast-path — returns null if calibration hasn't been loaded
 *  yet, otherwise the corrected value. For hot paths that can't await. */
export function calibrateSync(predicted: number): number | null {
  if (cached === undefined) return null;
  if (cached === null) return predicted;
  return applyCalibrationModel(cached, predicted);
}
