// src/lib/sports/nhl/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nhlExtractStat } from "./extract";
export const nhlAdapter: SportAdapter = {
  leagues: ["NHL", "NHL1P"],
  displayName: "NHL",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 3, y - 2, y - 1, y]; },
  supportedStats: ["Goals","Assists","Points","Shots","SOG","Hits","Blocks","Goalie Saves","Saves","Goals Allowed","Save Percentage"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: nhlExtractStat,
  project: async () => ({ available: false, reason: "NHL projection model not yet inlined" }),
};
