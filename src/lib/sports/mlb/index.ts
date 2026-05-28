import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { mlbExtractStat } from "./extract";
import type { Prop } from "@/lib/types";

const SUPPORTED_STATS = [
  "Hits", "Runs", "RBIs", "Home Runs", "Total Bases", "TB", "Stolen Bases", "SB", "Walks", "Strikeouts",
  "Hits+Runs+RBIs", "Hitter Fantasy Score", "Hitter FS", "Hitter Ks", "Singles", "Doubles",
  "Pitcher Strikeouts", "Ks", "Pitcher Walks", "Pitcher Hits Allowed", "Hits Allowed",
  "Earned Runs", "Earned Runs Allowed", "Pitcher Outs", "Ks + TB",
  "Pitches Thrown", "Pitcher FS",
];

export const mlbAdapter: SportAdapter = {
  leagues: ["MLB", "MLBLIVE"],
  displayName: "MLB",
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
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
