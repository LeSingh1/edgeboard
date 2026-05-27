import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ncaamAdapter } from "./index";
import type { RawGame } from "@/lib/sports/types";

const game: RawGame = {
  eventId: "e1",
  gameDate: "2026-12-15",
  stats: { PTS: 22, REB: 7, AST: 4, BLK: 1, STL: 2, "3PM": 3, FGM: 8, FGA: 18, FTM: 3, FTA: 4, TO: 2 },
};

describe("ncaamAdapter", () => {
  it("extracts basketball stats via NBA extractor", () => {
    assert.equal(ncaamAdapter.extractStat(game, "Points"), 22);
    assert.equal(ncaamAdapter.extractStat(game, "PRA"), 22 + 7 + 4);
  });
  it("supports SACB league key", () => {
    assert.ok(ncaamAdapter.leagues.includes("SACB"));
  });
});
