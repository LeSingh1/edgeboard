// src/lib/sports/nhl/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nhlExtractStat } from "./extract";
export const nhlAdapter: SportAdapter = {
  leagues: ["NHL", "NHL1P"],
  displayName: "NHL",
  hasLiveProjection: true, // fast ESPN search + gamelog (skater scoring stats)
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: ["Goals","Assists","Points","Shots","SOG","Hits","Blocks","Goalie Saves","Saves","Goals Allowed","Save Percentage"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: nhlExtractStat,
  // Real game-log projection (ESPN). Skater scoring stats (Points/Goals/Assists/
  // SOG/Plus-Minus/PP Points) resolve; goalie/hits/blocks/faceoffs return
  // unavailable → excluded by the no-mock gate, never the implied placeholder.
  project: async (prop) => {
    const { nhlLiveProjection } = await import("@/lib/sports/espnLiveProjection");
    return nhlLiveProjection(prop);
  },
};
