import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trainingSeasons } from "./index";

describe("WNBA training seasons", () => {
  it("returns a four-year window (short 40-game season needs depth)", () => {
    const seasons = trainingSeasons();
    assert.equal(seasons.length, 4);
    const y = new Date().getFullYear();
    assert.deepEqual(seasons, [y - 3, y - 2, y - 1, y]);
  });
});
