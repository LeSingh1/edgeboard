import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nflExtractStat } from "./extract";

export const nflAdapter: SportAdapter = {
  leagues: ["NFL", "NFLSZN"],
  displayName: "NFL",
  hasLiveProjection: true, // fast ESPN search + gamelog (per-game NFL props; NFLSZN season totals excluded)
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: [
    "Pass Yards", "Pass Completions", "Pass Attempts", "Pass TDs", "INT",
    "Receptions", "Rec Yards", "Rec TDs",
    "Rush Yards", "Rush Attempts", "Rush TDs",
    "Rush+Rec Yards", "Pass+Rush Yards", "Rush+Rec TDs",
    "Sacks", "Tackles", "Solo Tackles",
    "Longest Reception", "Longest Rush",
  ],
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: nflExtractStat,
  // Real game-log projection (ESPN). Per-game passing/rushing/receiving stats
  // resolve via block-anchored extraction; Sacks/Tackles/Longest and NFLSZN
  // season totals return unavailable → excluded by the gate, never faked.
  project: async (prop) => {
    const { nflLiveProjection } = await import("@/lib/sports/espnLiveProjection");
    return nflLiveProjection(prop);
  },
};
