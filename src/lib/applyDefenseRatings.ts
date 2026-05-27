/**
 * Live-side loader for the per-team defensive ratings.
 *
 * Reads `data/backtest/defenseRatings.json` lazily on first call,
 * caches in memory for the process lifetime. Returns the typed model
 * or `null` if the file doesn't exist (graceful no-op when the backtest
 * hasn't run yet).
 *
 * Same pattern as `applyCalibration.ts`. Kill-switch:
 * `DISABLE_DEFENSE_SIGNAL=1` in the server env.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { defensiveDelta, type DefenseRatings } from "@/lib/backtest/defenseRatings";

const DEFENSE_PATH = path.join(process.cwd(), "data", "backtest", "defenseRatings.json");

let cached: DefenseRatings | null | undefined;
let pendingLoad: Promise<void> | null = null;

async function loadDefense(): Promise<void> {
  try {
    const raw = await fs.readFile(DEFENSE_PATH, "utf8");
    cached = JSON.parse(raw) as DefenseRatings;
  } catch {
    cached = null;
  }
}

export async function getDefenseRatings(): Promise<DefenseRatings | null> {
  if (process.env.DISABLE_DEFENSE_SIGNAL === "1") return null;
  if (cached !== undefined) return cached;
  if (!pendingLoad) pendingLoad = loadDefense();
  await pendingLoad;
  return cached ?? null;
}

export function getDefensiveDeltaSync(
  opponent: string,
  stat: string,
): { delta: number; sample: number } | null {
  if (process.env.DISABLE_DEFENSE_SIGNAL === "1") return null;
  if (!cached) return null;
  return defensiveDelta(cached, opponent, stat);
}

export function resetDefenseCache(): void {
  cached = undefined;
  pendingLoad = null;
}
