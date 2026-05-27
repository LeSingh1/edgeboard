/**
 * Live-side loader for the per-player breakout profiles.
 *
 * Loads `data/backtest/breakoutProfiles.json` lazily on first call.
 * The profile-lookup math lives in `src/lib/backtest/breakoutProfile.ts`
 * so live + backtest share one source of truth.
 *
 * Kill-switch: `DISABLE_BREAKOUT_SIGNAL=1`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  breakoutExcess,
  type BreakoutProfiles,
  type BreakoutSignalConfig,
} from "@/lib/backtest/breakoutProfile";

const PROFILES_PATH = path.join(process.cwd(), "data", "backtest", "breakoutProfiles.json");

// Cache state — bump via source edit to force HMR re-eval.
let cached: BreakoutProfiles | null | undefined;
let pendingLoad: Promise<void> | null = null;

async function load(): Promise<void> {
  try {
    const raw = await fs.readFile(PROFILES_PATH, "utf8");
    cached = JSON.parse(raw) as BreakoutProfiles;
  } catch {
    cached = null;
  }
}

export async function getBreakoutProfiles(): Promise<BreakoutProfiles | null> {
  if (process.env.DISABLE_BREAKOUT_SIGNAL === "1") return null;
  if (cached !== undefined) return cached;
  if (!pendingLoad) pendingLoad = load();
  await pendingLoad;
  return cached ?? null;
}

export function breakoutExcessSync(args: {
  playerName: string;
  stat: string;
  context: {
    opponentDefenseDelta: number | null;
    isHome: boolean | undefined;
    isPlayoff: boolean;
  };
  config?: BreakoutSignalConfig;
}): { excess: number; sample: number; bucket: string } | null {
  if (process.env.DISABLE_BREAKOUT_SIGNAL === "1") return null;
  if (!cached) return null;
  return breakoutExcess({ profiles: cached, ...args });
}

export function resetBreakoutCache(): void {
  cached = undefined;
  pendingLoad = null;
}
