// src/lib/sports/tennis/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { tennisExtractStat } from "./extract";
export const tennisAdapter: SportAdapter = {
  leagues: ["TENNIS"],
  displayName: "Tennis",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: ["Aces","Double Faults","Break Points Won","Break Points Saved","Total Games","Total Games Won","Sets Won","First Serve Percentage"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: tennisExtractStat,
  project: async () => ({ available: false, reason: "Tennis projection model not yet inlined" }),
};
