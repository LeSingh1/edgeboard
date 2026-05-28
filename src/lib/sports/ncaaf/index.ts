// src/lib/sports/ncaaf/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { nflExtractStat } from "@/lib/sports/nfl/extract";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
export const ncaafAdapter: SportAdapter = {
  leagues: ["NCAAF"],
  displayName: "NCAAF",
  trainingSeasons: () => { const y = new Date().getFullYear(); return Array.from({ length: 10 }, (_, i) => y - 9 + i); },
  supportedStats: ["Pass Yards","Pass Completions","Pass Attempts","Pass TDs","INT","Receptions","Rec Yards","Rec TDs","Rush Yards","Rush Attempts","Rush TDs","Rush+Rec Yards","Pass+Rush Yards","Sacks","Tackles","Solo Tackles"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: nflExtractStat,
  project: async () => ({ available: false, reason: "NCAAF projection model not yet inlined" }),
};
