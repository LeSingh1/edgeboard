import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nbaExtractStat } from "./extract";
import type { Prop } from "@/lib/types";

const SUPPORTED_STATS = [
  "Points", "Rebounds", "Assists", "Steals", "Blocked Shots", "3PTM", "3PTA",
  "FG Made", "FG Attempted", "FTM", "FTA", "Turnovers", "Personal Fouls",
  "2-PT Made", "2-PT Att", "Double-Double",
  "PRA", "Pts+Rebs", "Pts+Asts", "Rebs+Asts", "Blks+Stls", "Fantasy Score",
];

export const nbaAdapter: SportAdapter = {
  leagues: [
    "NBA", "NBA1Q", "NBA2Q", "NBA3Q", "NBA4Q", "NBA1H", "NBA2H",
    "NBAPTS", "NBAAST", "NBA3PT",
  ],
  displayName: "NBA",
  trainingSeasons: () => {
    const y = new Date().getFullYear();
    return [y];
  },
  supportedStats: SUPPORTED_STATS,
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: nbaExtractStat,
  project: async (prop: Prop) => {
    // Delegate to existing nbaProjection() during transition, then layer
    // calibration on top (the previous projectionFor dispatch was the only
    // caller of applyCalibrationToResult — moving it here keeps the path
    // intact for the registry-routed flow).
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
