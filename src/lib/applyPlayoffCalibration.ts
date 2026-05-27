/**
 * Live-side loader for the playoff-specific calibration overlay + the
 * round-2 team set.
 *
 * The overlay only fires when ALL of these are true:
 *   1. `data/backtest/playoffCalibration.json` exists (overlay trained)
 *   2. `data/backtest/round2Teams.json` exists AND the prop's team is in it
 *   3. `DISABLE_PLAYOFF_CALIBRATION` env var is not set
 *
 * Trained by `scripts/playoff-deep.ts` on the round-2-team subset of the
 * corpus. Layers on top of the base per-stat × per-oddsType calibration.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  applyCalibrationModel,
  type CalibrationModel,
} from "@/lib/backtest/fitCalibration";

const CAL_PATH = path.join(process.cwd(), "data", "backtest", "playoffCalibration.json");
const TEAMS_PATH = path.join(process.cwd(), "data", "backtest", "round2Teams.json");

// Cache state — HMR-resilient. The reload timestamp at the top of this
// module forces re-evaluation when source changes, which resets these.
let cachedModel: CalibrationModel | null | undefined;
let cachedTeams: Set<string> | null | undefined;
let pendingLoad: Promise<void> | null = null;

async function load(): Promise<void> {
  const [modelRaw, teamsRaw] = await Promise.all([
    fs.readFile(CAL_PATH, "utf8").catch(() => null),
    fs.readFile(TEAMS_PATH, "utf8").catch(() => null),
  ]);
  cachedModel = modelRaw ? (JSON.parse(modelRaw) as CalibrationModel) : null;
  if (teamsRaw) {
    const parsed = JSON.parse(teamsRaw) as { teams?: string[] };
    cachedTeams = new Set((parsed.teams ?? []).map((t) => t.toUpperCase()));
  } else {
    cachedTeams = null;
  }
}

export async function getPlayoffCalibration(): Promise<CalibrationModel | null> {
  if (process.env.DISABLE_PLAYOFF_CALIBRATION === "1") return null;
  if (cachedModel !== undefined) return cachedModel;
  if (!pendingLoad) pendingLoad = load();
  await pendingLoad;
  return cachedModel ?? null;
}

export async function getRound2Teams(): Promise<Set<string> | null> {
  if (cachedTeams !== undefined) return cachedTeams;
  if (!pendingLoad) pendingLoad = load();
  await pendingLoad;
  return cachedTeams ?? null;
}

/** Check synchronously whether a team is in the round-2 set. Returns
 *  `false` if the team set hasn't loaded or the team isn't a member. */
export function isRound2TeamSync(teamAbbr: string | undefined): boolean {
  if (!teamAbbr) return false;
  if (!cachedTeams) return false;
  return cachedTeams.has(teamAbbr.toUpperCase());
}

export function applyPlayoffCalibrationSync(predicted: number): number {
  if (process.env.DISABLE_PLAYOFF_CALIBRATION === "1") return predicted;
  if (!cachedModel || cachedModel.breakpoints.length === 0) return predicted;
  return applyCalibrationModel(cachedModel, predicted);
}

export function resetPlayoffCalibrationCache(): void {
  cachedModel = undefined;
  cachedTeams = undefined;
  pendingLoad = null;
}
