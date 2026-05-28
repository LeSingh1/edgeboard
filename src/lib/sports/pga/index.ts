import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { pgaExtractStat } from "./extract";
export const pgaAdapter: SportAdapter = {
  leagues: ["PGA"],
  displayName: "PGA",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: ["Strokes","Birdies","Pars","Bogeys","Eagles","Birdies Or Better","Birdies or Better Matchup","Fairways Hit","Greens in Regulation","Greens In Regulation","Putts"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: pgaExtractStat,
  project: async () => ({ available: false, reason: "PGA projection model not yet inlined" }),
};
