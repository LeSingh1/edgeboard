import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nflExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const qb: RawGame = { eventId: "e", gameDate: "2026-09-08", stats: { CMP: 24, ATT: 38, "YDS-pass": 285, "TD-pass": 2, INT: 1, "YDS-rush": 18, "TD-rush": 0, "ATT-rush": 4 } };
const wr: RawGame = { eventId: "e", gameDate: "2026-09-08", stats: { REC: 7, "YDS-rec": 102, "TD-rec": 1, "ATT-rush": 1, "YDS-rush": 5 } };

describe("nflExtractStat", () => {
  it("QB pass stats", () => {
    assert.equal(nflExtractStat(qb, "Pass Yards"), 285);
    assert.equal(nflExtractStat(qb, "Pass Completions"), 24);
    assert.equal(nflExtractStat(qb, "Pass Attempts"), 38);
    assert.equal(nflExtractStat(qb, "Pass TDs"), 2);
    assert.equal(nflExtractStat(qb, "INT"), 1);
  });
  it("Receiving stats", () => {
    assert.equal(nflExtractStat(wr, "Receptions"), 7);
    assert.equal(nflExtractStat(wr, "Rec Yards"), 102);
    assert.equal(nflExtractStat(wr, "Rec TDs"), 1);
  });
  it("Rush stats", () => {
    assert.equal(nflExtractStat(qb, "Rush Yards"), 18);
    assert.equal(nflExtractStat(qb, "Rush Attempts"), 4);
  });
});
