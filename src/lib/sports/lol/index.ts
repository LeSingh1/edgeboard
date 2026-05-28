import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { lolExtractStat } from "./extract";

export const lolAdapter: SportAdapter = {
  leagues: ["LOL"],
  displayName: "LoL",
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: ["Kills", "Deaths", "Assists", "CS", "Kills+Assists"],
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: lolExtractStat,
  project: async () => ({ available: false, reason: "LoL projection model not yet inlined" }),
};
