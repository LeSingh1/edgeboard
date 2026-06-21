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
  // Real game-log projection (ESPN soccer/all), then gated + calibrated against
  // the TRAINED soccer model: a World Cup prop only bets when the trained model
  // has a calibration bucket for its stat|oddsType (Goals/Assists/Fouls/Saves/
  // Goals Allowed, standard only). Untrained stats (Shots, SOT) and untrained
  // rungs (goblin/demon) are excluded — "if it isn't trained, don't bet on it".
  project: async (prop, artifacts) => {
    const { soccerLiveProjection } = await import("@/lib/sports/espnLiveProjection");
    const { calibrateSoccer } = await import("./calibrate");
    const raw = await soccerLiveProjection(prop);
    return calibrateSoccer(raw, prop, artifacts);
  },
};
