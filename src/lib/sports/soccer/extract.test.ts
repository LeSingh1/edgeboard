// src/lib/sports/soccer/extract.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { soccerExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const field: RawGame = { eventId: "e", gameDate: "2026-09-15", stats: { G: 1, A: 1, SHOT: 4, SOG: 2, FC: 2, FA: 1, type: "field" } };
const gk: RawGame = { eventId: "e", gameDate: "2026-09-15", stats: { SV: 5, GA: 1, type: "goalkeeper" } };

describe("soccerExtractStat", () => {
  it("field player", () => {
    assert.equal(soccerExtractStat(field, "Goals"), 1);
    assert.equal(soccerExtractStat(field, "Assists"), 1);
    assert.equal(soccerExtractStat(field, "Shots"), 4);
    assert.equal(soccerExtractStat(field, "Shots on Target"), 2);
  });
  it("goalkeeper", () => {
    assert.equal(soccerExtractStat(gk, "Saves"), 5);
    assert.equal(soccerExtractStat(gk, "Goals Allowed"), 1);
  });
  it("returns null for unsupported", () => {
    assert.equal(soccerExtractStat(field, "Saves"), null);  // field player has no SV
  });
});
