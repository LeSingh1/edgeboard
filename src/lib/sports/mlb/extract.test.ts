import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mlbExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const hitter: RawGame = {
  eventId: "e1", gameDate: "2026-05-15",
  stats: { hits: 2, runs: 1, rbi: 3, homeRuns: 1, stolenBases: 0, totalBases: 5, walks: 1, strikeouts: 1, atBats: 4, type: "hitter" },
};
const pitcher: RawGame = {
  eventId: "e2", gameDate: "2026-05-15",
  stats: { strikeouts: 7, hits: 4, earnedRuns: 2, walks: 2, inningsPitched: 6, pitchCount: 95, type: "pitcher" },
};

describe("mlbExtractStat", () => {
  it("extracts hitter stats", () => {
    assert.equal(mlbExtractStat(hitter, "Hits"), 2);
    assert.equal(mlbExtractStat(hitter, "Total Bases"), 5);
    assert.equal(mlbExtractStat(hitter, "Hits+Runs+RBIs"), 2 + 1 + 3);
  });
  it("extracts pitcher stats", () => {
    assert.equal(mlbExtractStat(pitcher, "Pitcher Strikeouts"), 7);
    assert.equal(mlbExtractStat(pitcher, "Pitcher Walks"), 2);
    assert.equal(mlbExtractStat(pitcher, "Pitcher Outs"), 18);
  });
  it("returns null when stat doesn't fit role", () => {
    assert.equal(mlbExtractStat(pitcher, "Hits"), null);
    assert.equal(mlbExtractStat(hitter, "Pitcher Strikeouts"), null);
  });
});
