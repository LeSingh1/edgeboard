import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nbaExtractStat } from "./extract";
import type { Prop } from "@/lib/types";

const SUPPORTED_STATS = [
  "Points", "Rebounds", "Assists", "Steals", "Blocked Shots", "3PTM", "3PTA",
  "FG Made", "FG Attempted", "FTM", "FTA", "Turnovers",
  "PRA", "Pts+Rebs", "Pts+Asts", "Rebs+Asts", "Blks+Stls", "Fantasy Score",
];

export const nbaAdapter: SportAdapter = {
  leagues: ["NBA", "NBA1Q", "NBA1H"],
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
    // Delegate to existing nbaProjection() during transition
    const { nbaProjection } = await import("@/lib/realProjections");
    return nbaProjection(prop);
  },
};
