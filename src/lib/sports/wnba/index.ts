import type { SportAdapter } from "@/lib/sports/types";
import { nbaExtractStat } from "@/lib/sports/nba/extract";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import type { Prop } from "@/lib/types";

export function trainingSeasons(): number[] {
  const y = new Date().getFullYear();
  return [y - 1, y];   // WNBA: short 40-game season → pull two years
}

const SUPPORTED_STATS = [
  "Points", "Rebounds", "Assists", "Steals", "Blocked Shots", "3PTM", "3PTA",
  "FG Made", "FG Attempted", "FTM", "FTA", "Turnovers", "Personal Fouls",
  "2-PT Made", "2-PT Att", "Double-Double",
  "PRA", "Pts+Rebs", "Pts+Asts", "Rebs+Asts", "Blks+Stls", "Fantasy Score",
];

export const wnbaAdapter: SportAdapter = {
  leagues: [
    "WNBA", "WNBA1Q", "WNBA2Q", "WNBA3Q", "WNBA4Q", "WNBA1H", "WNBA2H",
    "WNBAPTS", "WNBAAST", "WNBA3PT",
  ],
  displayName: "WNBA",
  trainingSeasons,
  supportedStats: SUPPORTED_STATS,
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: nbaExtractStat,
  project: async (prop: Prop) => {
    // Same wrapping pattern as the NBA adapter — see comment there.
    const { nbaProjection, applyCalibrationToResult } = await import("@/lib/realProjections");
    const raw = await nbaProjection(prop);
    return applyCalibrationToResult(
      raw,
      prop.oddsType as import("@/lib/backtest/fitCalibration").OddsTypeKey,
      prop.statType,
      prop.gameTime,
      prop.team,
    );
  },
};
