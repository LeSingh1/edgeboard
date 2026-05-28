// src/lib/sports/tennis/extract.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tennisExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const match: RawGame = { eventId: "e", gameDate: "2026-07-01", stats: { SETS: 2, GW: 13, TOTAL_GAMES: 22 } };

describe("tennisExtractStat", () => {
  it("basic stats", () => {
    assert.equal(tennisExtractStat(match, "Sets Won"), 2);
    assert.equal(tennisExtractStat(match, "Total Games"), 13);
    assert.equal(tennisExtractStat(match, "Total Games Won"), 13);
  });
  it("returns null for unsupported", () => {
    assert.equal(tennisExtractStat(match, "Aces"), null);
    assert.equal(tennisExtractStat(match, "Unsupported"), null);
  });
});
