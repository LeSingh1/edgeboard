import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nbaExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const game: RawGame = {
  eventId: "e1",
  gameDate: "2026-05-15",
  stats: { PTS: 28, REB: 8, AST: 6, BLK: 1, STL: 2, "3PM": 4, FGM: 10, FGA: 22, FTM: 4, FTA: 5, TO: 3, MIN: 35 },
};

describe("nbaExtractStat", () => {
  it("extracts simple stats", () => {
    assert.equal(nbaExtractStat(game, "Points"), 28);
    assert.equal(nbaExtractStat(game, "Rebounds"), 8);
    assert.equal(nbaExtractStat(game, "Assists"), 6);
  });

  it("extracts combined stats", () => {
    assert.equal(nbaExtractStat(game, "PRA"), 28 + 8 + 6);
    assert.equal(nbaExtractStat(game, "Pts+Rebs"), 28 + 8);
    assert.equal(nbaExtractStat(game, "Pts+Asts"), 28 + 6);
    assert.equal(nbaExtractStat(game, "Rebs+Asts"), 8 + 6);
    assert.equal(nbaExtractStat(game, "Blks+Stls"), 1 + 2);
  });

  it("returns null for unsupported stats", () => {
    assert.equal(nbaExtractStat(game, "Unsupported"), null);
  });
});
