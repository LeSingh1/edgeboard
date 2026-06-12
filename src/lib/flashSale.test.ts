/**
 * Flash-sale pricing. A PrizePicks flash sale discounts the line in your favor,
 * so the auto-pilot must price the pick at the DISCOUNTED line (where the hit
 * probability is higher) and bet at that line. The higher probability is what
 * makes a discounted pick rank above its full-price peers — favored on real
 * edge, not an arbitrary boost. Covers effectiveLine() and the re-pricing path
 * inside buildAutoLineups.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAutoLineups, effectiveLine } from "./autoPilot";
import type { Prop } from "./types";
import type { ProjectionResult } from "./realProjections";
import "./sports/registerAll";

const proj = (o: Record<string, unknown>): ProjectionResult => o as unknown as ProjectionResult;

function mkProp(over: Partial<Prop>): Prop {
  return {
    id: "x", source: "prizepicks", sport: "NBA", league: "NBA",
    playerName: "Test Player", team: "AAA", opponent: "BBB",
    gameTime: "2026-06-11T23:00:00Z", statType: "Points", line: 20.5,
    status: "active", oddsType: "standard", pMore: 0.5, pLess: 0.5,
    modelVersion: "nba-espn-v1+iso",
    ...over,
  };
}

describe("effectiveLine — the line a pick is actually bet at", () => {
  it("uses the flash-sale line when one is active", () => {
    assert.equal(effectiveLine(mkProp({ line: 30.5, flashSaleLine: 19.5 })), 19.5);
  });
  it("falls back to the standard line with no (or a no-op) flash sale", () => {
    assert.equal(effectiveLine(mkProp({ line: 30.5 })), 30.5);
    assert.equal(effectiveLine(mkProp({ line: 30.5, flashSaleLine: 30.5 })), 30.5);
  });
});

describe("buildAutoLineups — flash sales are priced at the discount and favored", () => {
  // Model: mean 25, sigma 6. At the FULL 30.5 line a MORE is a long shot
  // (~0.18) — the value side would be LESS. At the 19.5 FLASH line a MORE is
  // ~0.82. So the side + line a build chooses tells us which line it priced.
  const real = {
    flash: proj({ available: true, pMore: 0.18, pLess: 0.82, projection: 25, sigma: 6, recent: [24, 26, 25, 27, 23] }),
    plain: proj({ available: true, pMore: 0.7, pLess: 0.3, projection: 12, sigma: 3, recent: [13, 12, 14, 11, 13] }),
  };
  const flashProp = (over: Partial<Prop> = {}): Prop =>
    mkProp({ id: "flash", playerName: "Flash Guy", team: "AAA", statType: "Points", line: 30.5, flashSaleLine: 19.5, ...over });
  const plainProp = mkProp({ id: "plain", playerName: "Plain Guy", team: "BBB", statType: "Rebounds", line: 10.5 });

  it("re-prices the flash prop at the discount: MORE at the easy line, ~0.82", () => {
    const r = buildAutoLineups([flashProp(), plainProp], 2, 1, 5, { sport: "ALL", realProjections: real });
    const pick = r.lineups.flatMap((l) => l.picks).find((p) => p.prop.id === "flash");
    assert.ok(pick, "flash prop must make the slip");
    assert.equal(pick.side, "more", "the discounted line makes MORE the value side");
    assert.equal(effectiveLine(pick.prop), 19.5, "the pick is bet at the discounted line");
    assert.ok(pick.probability > 0.6, `discount-priced pick should be ~0.82, got ${pick.probability}`);
  });

  it("the SAME model WITHOUT the discount prices the full line: LESS at 30.5 (control)", () => {
    const r = buildAutoLineups([flashProp({ flashSaleLine: undefined }), plainProp], 2, 1, 5, { sport: "ALL", realProjections: real });
    const pick = r.lineups.flatMap((l) => l.picks).find((p) => p.prop.id === "flash");
    assert.ok(pick, "the prop still makes a slip, just on the other side");
    assert.equal(pick.side, "less", "at the full long line, LESS is the value side");
    assert.equal(effectiveLine(pick.prop), 30.5, "no discount → bet at the standard line");
  });
});
