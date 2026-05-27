import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nflExtractStat } from "./extract";

export const nflAdapter: SportAdapter = {
  leagues: ["NFL", "NFLSZN"],
  displayName: "NFL",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: [
    "Pass Yards", "Pass Completions", "Pass Attempts", "Pass TDs", "INT",
    "Receptions", "Rec Yards", "Rec TDs",
    "Rush Yards", "Rush Attempts", "Rush TDs",
    "Rush+Rec Yards", "Pass+Rush Yards",
    "Sacks", "Tackles", "Solo Tackles",
    "Longest Reception", "Longest Rush",
  ],
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: nflExtractStat,
  project: async () => ({ available: false, reason: "NFL projection model not yet inlined — using calibration table only" }),
};
