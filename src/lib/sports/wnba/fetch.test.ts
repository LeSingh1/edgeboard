import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trainingSeasons } from "./index";

describe("WNBA training seasons", () => {
  it("returns prior + current year", () => {
    const seasons = trainingSeasons();
    assert.equal(seasons.length, 2);
    const y = new Date().getFullYear();
    assert.deepEqual(seasons, [y - 1, y]);
  });
});
