import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAutoLineups, recommendLineupCount } from "./autoPilot";
import type { Prop } from "./types";

describe("recommendLineupCount — model decides how many slips", () => {
  const L = (probProfit: number) => ({ probProfit, hitProbability: probProfit });

  it("returns 1 when there is a single standout and the rest fall off a cliff", () => {
    const lineups = [L(0.7), L(0.45), L(0.42), L(0.4)]; // #2 is 25pp below best
    assert.equal(recommendLineupCount(lineups, 5), 1);
  });

  it("returns several when they are genuinely comparable", () => {
    const lineups = [L(0.62), L(0.6), L(0.58), L(0.3)]; // top 3 within 8pp, then a cliff
    assert.equal(recommendLineupCount(lineups, 5), 3);
  });

  it("never includes a slip below the 40% profit floor, even if close to best", () => {
    const lineups = [L(0.41), L(0.39), L(0.38)]; // best barely clears; rest under floor
    assert.equal(recommendLineupCount(lineups, 5), 1);
  });

  it("respects the ceiling (Max Spend cap)", () => {
    const lineups = [L(0.7), L(0.69), L(0.68), L(0.67)]; // all comparable
    assert.equal(recommendLineupCount(lineups, 2), 2);
  });

  it("returns 0 when there are no lineups", () => {
    assert.equal(recommendLineupCount([], 5), 0);
  });
});

/** Minimal valid Prop; override per case. */
function mkProp(over: Partial<Prop>): Prop {
  return {
    id: "x",
    source: "mock",
    sport: "WNBA",
    league: "WNBA",
    playerName: "Test Player",
    team: "AAA",
    opponent: "BBB",
    gameTime: "2026-06-06T23:00:00Z",
    statType: "Points",
    line: 20.5,
    status: "active",
    oddsType: "standard",
    pMore: 0.8,
    pLess: 0.2,
    modelVersion: "test",
    ...over,
  };
}

/**
 * Regression test for a real losing slip (WNBA, 2026-06-06). The "safe" 5-pick
 * build included Olivia Miles Under 6 assists — a WHOLE-NUMBER line. She landed
 * on exactly 6, which is a PUSH on PrizePicks, and that dropped the slip a full
 * flex tier. autoScore only down-weights integer lines (×0.72), so a strong one
 * could still ride into a safe slip. The fix excludes integer lines outright in
 * a safe posture. These tests pin that behavior so the push can't recur.
 */
describe("buildAutoLineups — push-safe filter (learned from a real losing slip)", () => {
  const halfLine = mkProp({
    id: "half",
    playerName: "Clean Half",
    statType: "Points",
    line: 19.5, // .5 line — can never push
  });
  const wholeLine = mkProp({
    id: "whole",
    playerName: "Push Risk",
    statType: "Assists",
    line: 6, // whole number — can land exactly on the line and push
  });

  it("excludes whole-number lines in the favor-consistency (default safe) posture", () => {
    const res = buildAutoLineups([halfLine, wholeLine], 2, 1, 5, {
      favorConsistency: true,
    });
    const ids = res.candidates.map((c) => c.id);
    assert.ok(ids.includes("half"), "the .5 line should survive");
    assert.ok(
      !ids.includes("whole"),
      "the whole-number line must be excluded in safe mode (push risk)",
    );
  });

  it("excludes whole-number lines in consistent-only mode too", () => {
    const res = buildAutoLineups([halfLine, wholeLine], 2, 1, 5, {
      consistentOnly: true,
    });
    assert.ok(!res.candidates.some((c) => Number.isInteger(c.line)));
  });

  it("KEEPS whole-number lines in balanced mode (only down-weighted, not removed)", () => {
    const res = buildAutoLineups([halfLine, wholeLine], 2, 1, 5, {
      favorConsistency: false,
    });
    const ids = res.candidates.map((c) => c.id);
    assert.ok(
      ids.includes("whole"),
      "balanced builds should still allow a strong whole-number pick",
    );
  });
});
