// src/lib/sports/ncaaf/extract.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ncaafAdapter } from "./index";
import type { RawGame } from "@/lib/sports/types";

const qb: RawGame = { eventId: "e", gameDate: "2026-09-08", stats: { CMP: 22, ATT: 33, "YDS-pass": 310, "TD-pass": 3, INT: 0, "YDS-rush": 25, "TD-rush": 1, "ATT-rush": 7 } };

describe("ncaafAdapter", () => {
  it("extracts football stats via NFL extractor", () => {
    assert.equal(ncaafAdapter.extractStat(qb, "Pass Yards"), 310);
    assert.equal(ncaafAdapter.extractStat(qb, "Pass TDs"), 3);
    assert.equal(ncaafAdapter.extractStat(qb, "Rush Yards"), 25);
  });
  it("registers NCAAF league key", () => {
    assert.ok(ncaafAdapter.leagues.includes("NCAAF"));
  });
});
