import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { npbExtractStat } from "./extract";

export const npbAdapter: SportAdapter = {
  leagues: ["NPB"],
  displayName: "NPB",
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: ["Hits", "Runs", "RBIs", "Stolen Bases", "At Bats", "Hits+Runs+RBIs"],
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: npbExtractStat,
  project: async () => ({ available: false, reason: "NPB projection model not yet inlined" }),
};
