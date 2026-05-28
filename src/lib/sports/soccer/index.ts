// src/lib/sports/soccer/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { soccerExtractStat } from "./extract";
export const soccerAdapter: SportAdapter = {
  leagues: ["SOCCER"],
  displayName: "Soccer",
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: ["Goals","Assists","Shots","Shots on Target","SOT","Fouls Committed","Fouls","Fouls Suffered","Goals+Assists","Goal + Assist","Saves","Goalie Saves","Goals Allowed"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: soccerExtractStat,
  project: async () => ({ available: false, reason: "Soccer projection model not yet inlined" }),
};
