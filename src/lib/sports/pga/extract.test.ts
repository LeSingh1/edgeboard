import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pgaExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const round: RawGame = { eventId: "e", gameDate: "2026-04-10", stats: { STROKES: 68, BIRDIES: 5, PARS: 11, BOGEYS: 2, EAGLES: 0, FH: 9, GIR: 14, PUTTS: 28 } };

describe("pgaExtractStat", () => {
  it("basic stats", () => {
    assert.equal(pgaExtractStat(round, "Strokes"), 68);
    assert.equal(pgaExtractStat(round, "Birdies"), 5);
    assert.equal(pgaExtractStat(round, "Pars"), 11);
    assert.equal(pgaExtractStat(round, "Fairways Hit"), 9);
    assert.equal(pgaExtractStat(round, "Greens in Regulation"), 14);
    assert.equal(pgaExtractStat(round, "Putts"), 28);
  });
  it("Birdies Or Better", () => {
    assert.equal(pgaExtractStat(round, "Birdies Or Better"), 5);  // 5 birdies + 0 eagles
  });
  it("returns null for unsupported", () => {
    assert.equal(pgaExtractStat(round, "Unsupported"), null);
  });
});
