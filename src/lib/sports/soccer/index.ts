// src/lib/sports/soccer/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { soccerExtractStat } from "./extract";
export const soccerAdapter: SportAdapter = {
  leagues: ["SOCCER"],
  displayName: "Soccer",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: ["Goals","Assists","Shots","Shots on Target","Fouls Committed","Fouls Suffered","Goals+Assists","Saves","Goals Allowed"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: soccerExtractStat,
  project: async () => ({ available: false, reason: "Soccer projection model not yet inlined" }),
};
