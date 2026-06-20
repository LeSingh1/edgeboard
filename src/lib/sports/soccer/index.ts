// src/lib/sports/soccer/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { soccerExtractStat } from "./extract";
export const soccerAdapter: SportAdapter = {
  // "WORLD CUP" is the PrizePicks league for the tournament; routing it here gives
  // those props the real ESPN game-log projection (recent club form).
  leagues: ["SOCCER", "WORLD CUP"],
  displayName: "Soccer",
  hasLiveProjection: true, // league-agnostic ESPN soccer gamelog (club form)
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: ["Goals","Assists","Shots","Shots on Target","SOT","Fouls Committed","Fouls","Fouls Suffered","Goals+Assists","Goal + Assist","Saves","Goalie Saves","Goals Allowed"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: soccerExtractStat,
  // Real game-log projection (ESPN soccer/all). Field scoring + goalie stats
  // resolve; passing/touches aren't in the gamelog → unavailable → excluded by
  // the no-mock gate, never the implied placeholder.
  project: async (prop) => {
    const { soccerLiveProjection } = await import("@/lib/sports/espnLiveProjection");
    return soccerLiveProjection(prop);
  },
};
