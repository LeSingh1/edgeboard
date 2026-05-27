import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aflExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const game: RawGame = { eventId: "e", gameDate: "2026-04-10", stats: { D: 24, K: 14, HB: 10, M: 7, T: 3, G: 2, B: 1 } };

describe("aflExtractStat", () => {
  it("basic stats", () => {
    assert.equal(aflExtractStat(game, "Disposals"), 24);
    assert.equal(aflExtractStat(game, "Kicks"), 14);
    assert.equal(aflExtractStat(game, "Handballs"), 10);
    assert.equal(aflExtractStat(game, "Marks"), 7);
    assert.equal(aflExtractStat(game, "Tackles"), 3);
    assert.equal(aflExtractStat(game, "Goals"), 2);
  });
  it("returns null for unsupported", () => {
    assert.equal(aflExtractStat(game, "Unsupported"), null);
  });
});
