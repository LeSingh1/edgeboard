import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { aflExtractStat } from "./extract";
export const aflAdapter: SportAdapter = {
  leagues: ["AFL"],
  displayName: "AFL",
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: ["Disposals","Kicks","Handballs","Marks","Tackles","Goals","Behinds","Score Involvements"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: aflExtractStat,
  project: async () => ({ available: false, reason: "AFL projection model not yet inlined" }),
};
