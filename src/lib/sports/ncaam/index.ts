import type { SportAdapter } from "@/lib/sports/types";
import { nbaExtractStat } from "@/lib/sports/nba/extract";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
export const ncaamAdapter: SportAdapter = {
  leagues: ["SACB", "NCAAM"],
  displayName: "NCAAM",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 3, y - 2, y - 1, y]; },
  supportedStats: ["Points","Rebounds","Assists","Steals","Blocked Shots","3PTM","3PTA","FG Made","FG Attempted","FTM","FTA","Turnovers","PRA","Pts+Rebs","Pts+Asts","Rebs+Asts","Blks+Stls"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: nbaExtractStat,
  project: async () => ({ available: false, reason: "NCAAM projection model not yet inlined" }),
};
