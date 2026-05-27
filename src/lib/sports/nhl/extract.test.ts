// src/lib/sports/nhl/extract.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nhlExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const skater: RawGame = { eventId: "e", gameDate: "2026-10-08", stats: { G: 1, A: 2, SOG: 5, "+/-": 2, PIM: 0, type: "skater" } };
const goalie: RawGame = { eventId: "e", gameDate: "2026-10-08", stats: { SA: 30, SV: 28, GA: 2, type: "goalie" } };

describe("nhlExtractStat", () => {
  it("skater", () => {
    assert.equal(nhlExtractStat(skater, "Goals"), 1);
    assert.equal(nhlExtractStat(skater, "Assists"), 2);
    assert.equal(nhlExtractStat(skater, "Points"), 3);
    assert.equal(nhlExtractStat(skater, "Shots"), 5);
  });
  it("goalie", () => {
    assert.equal(nhlExtractStat(goalie, "Goalie Saves"), 28);
    assert.equal(nhlExtractStat(goalie, "Goals Allowed"), 2);
  });
});
