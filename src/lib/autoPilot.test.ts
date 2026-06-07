import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAutoLineups } from "./autoPilot";
import type { Prop } from "./types";

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
