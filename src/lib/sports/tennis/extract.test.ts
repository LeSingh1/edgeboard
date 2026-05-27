// src/lib/sports/tennis/extract.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tennisExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const match: RawGame = { eventId: "e", gameDate: "2026-07-01", stats: { ACES: 12, DF: 3, "1ST-SVP": 65, BPC: 4, BPS: 6, GW: 22, SETS: 3, MATCH_WON: 1 } };

describe("tennisExtractStat", () => {
  it("basic stats", () => {
    assert.equal(tennisExtractStat(match, "Aces"), 12);
    assert.equal(tennisExtractStat(match, "Double Faults"), 3);
    assert.equal(tennisExtractStat(match, "Break Points Won"), 4);
    assert.equal(tennisExtractStat(match, "Total Games"), 22);
    assert.equal(tennisExtractStat(match, "Sets Won"), 3);
  });
  it("returns null for unsupported", () => {
    assert.equal(tennisExtractStat(match, "Unsupported"), null);
  });
});
