import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trainingSeasons } from "./index";

describe("WNBA training seasons", () => {
  it("returns a ten-year window (max historical depth per player)", () => {
    const seasons = trainingSeasons();
    assert.equal(seasons.length, 10);
    const y = new Date().getFullYear();
    assert.deepEqual(seasons, Array.from({ length: 10 }, (_, i) => y - 9 + i));
  });
});
