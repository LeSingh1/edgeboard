import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { mlbExtractStat } from "./extract";
import type { Prop } from "@/lib/types";

const SUPPORTED_STATS = [
  "Hits", "Runs", "RBIs", "Home Runs", "Total Bases", "Stolen Bases", "Walks", "Strikeouts",
  "Hits+Runs+RBIs", "Hitter Fantasy Score",
  "Pitcher Strikeouts", "Ks", "Pitcher Walks", "Pitcher Hits Allowed", "Hits Allowed", "Earned Runs", "Pitcher Outs", "Ks + TB",
];

export const mlbAdapter: SportAdapter = {
  leagues: ["MLB", "MLBLIVE"],
  displayName: "MLB",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: SUPPORTED_STATS,
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: mlbExtractStat,
  project: async (prop: Prop) => {
    const { mlbProjection } = await import("@/lib/realProjections");
    return mlbProjection(prop);
  },
};
