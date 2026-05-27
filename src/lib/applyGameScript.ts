/**
 * Live-side loader for the game-script profile + team-scoring profile.
 *
 * Reads `data/backtest/gameScriptProfile.json` and
 * `data/backtest/teamScoring.json` lazily on first call. Same pattern as
 * `applyDefenseRatings.ts`. Kill-switch: `DISABLE_GAME_SCRIPT_SIGNAL=1`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  gameScriptDelta,
  expectedMarginFor,
  type GameScriptProfile,
  type TeamScoring,
} from "@/lib/backtest/gameScript";

const PROFILE_PATH = path.join(process.cwd(), "data", "backtest", "gameScriptProfile.json");
const SCORING_PATH = path.join(process.cwd(), "data", "backtest", "teamScoring.json");

let cachedProfile: GameScriptProfile | null | undefined;
let cachedScoring: TeamScoring | null | undefined;
let pendingLoad: Promise<void> | null = null;

async function load(): Promise<void> {
  const [profileRaw, scoringRaw] = await Promise.all([
    fs.readFile(PROFILE_PATH, "utf8").catch(() => null),
    fs.readFile(SCORING_PATH, "utf8").catch(() => null),
  ]);
  cachedProfile = profileRaw ? (JSON.parse(profileRaw) as GameScriptProfile) : null;
  cachedScoring = scoringRaw ? (JSON.parse(scoringRaw) as TeamScoring) : null;
}

export async function getGameScript(): Promise<{
  profile: GameScriptProfile | null;
  scoring: TeamScoring | null;
}> {
  if (process.env.DISABLE_GAME_SCRIPT_SIGNAL === "1") {
    return { profile: null, scoring: null };
  }
  if (cachedProfile !== undefined && cachedScoring !== undefined) {
    return { profile: cachedProfile, scoring: cachedScoring };
  }
  if (!pendingLoad) pendingLoad = load();
  await pendingLoad;
  return { profile: cachedProfile ?? null, scoring: cachedScoring ?? null };
}

export function getGameScriptDeltaSync(params: {
  stat: string;
  expectedMargin: number;
  teamWillWin: boolean;
  isStarter: boolean;
}): { delta: number; sample: number; bucket: string } | null {
  if (process.env.DISABLE_GAME_SCRIPT_SIGNAL === "1") return null;
  if (!cachedProfile) return null;
  return gameScriptDelta(cachedProfile, params);
}

export function getExpectedMarginSync(
  teamAbbr: string | undefined,
  opponentAbbr: string | undefined,
): { margin: number; sample: number } | null {
  if (process.env.DISABLE_GAME_SCRIPT_SIGNAL === "1") return null;
  if (!cachedScoring) return null;
  return expectedMarginFor(cachedScoring, teamAbbr, opponentAbbr);
}

export function resetGameScriptCache(): void {
  cachedProfile = undefined;
  cachedScoring = undefined;
  pendingLoad = null;
}
