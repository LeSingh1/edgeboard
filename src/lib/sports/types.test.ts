import type { SportAdapter, RawGame, PlayerRef, SportArtifacts, Adjustment } from "./types";

// Compile-time tests: these will fail TS check if the types don't exist or have wrong shapes.
const _adapter: SportAdapter = {
  leagues: ["TEST"],
  displayName: "Test",
  trainingSeasons: () => [2025, 2026],
  supportedStats: ["Stat1"],
  fetchPlayerRoster: async () => [] as PlayerRef[],
  fetchPlayerGamelog: async () => [] as RawGame[],
  fetchTeamSchedule: async () => [],
  extractStat: () => null,
  project: async () => ({ available: false, reason: "test" }),
};
const _adj: Adjustment = { label: "x", shift: 0, pMoreSwing: 0, confidence: 0, reason: "" };
const _art: SportArtifacts = { calibration: null, defenseRatings: null, breakoutProfiles: null, gameScriptProfile: null, metadata: { trainedAt: "", sampleSize: 0, version: "" } };
export { _adapter, _adj, _art };
