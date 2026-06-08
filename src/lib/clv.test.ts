import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeClv, summarizeClv, type RecordedPick } from "./clv";

function pick(over: Partial<RecordedPick>): RecordedPick {
  return {
    id: "p",
    sport: "WNBA",
    player: "Test",
    statType: "Points",
    side: "more",
    lineAtPick: 20.5,
    pAtPick: 0.6,
    pickedAt: "2026-06-06T18:00:00Z",
    ...over,
  };
}

describe("computeClv — sign convention", () => {
  it("returns null until the close is captured", () => {
    assert.equal(computeClv(pick({})), null);
  });

  it("OVER that the line moved UP on = negative CLV (we lost value)", () => {
    // Real case: Rhyne Howard points, picked Over 14.5, line closed 15.5.
    const r = computeClv(pick({ side: "more", lineAtPick: 14.5, lineAtClose: 15.5 }));
    assert.equal(r?.clvPoints, -1);
    assert.equal(r?.beatClose, false);
  });

  it("OVER that the line moved DOWN on = positive CLV (we beat the close)", () => {
    const r = computeClv(pick({ side: "more", lineAtPick: 20.5, lineAtClose: 19.5 }));
    assert.equal(r?.clvPoints, 1);
    assert.equal(r?.beatClose, true);
  });

  it("UNDER that the line dropped on = negative CLV (it got harder)", () => {
    // Real case: Caitlin Clark points, picked Under 19.5, line closed 18.5.
    const r = computeClv(pick({ side: "less", lineAtPick: 19.5, lineAtClose: 18.5 }));
    assert.equal(r?.clvPoints, -1);
    assert.equal(r?.beatClose, false);
  });

  it("UNDER that the line rose on = positive CLV (we beat the close)", () => {
    const r = computeClv(pick({ side: "less", lineAtPick: 19.5, lineAtClose: 21 }));
    assert.equal(r?.clvPoints, 1.5);
    assert.equal(r?.beatClose, true);
  });
});

describe("summarizeClv", () => {
  it("counts tracked vs closed and computes beat rate", () => {
    const s = summarizeClv([
      pick({ id: "a", side: "more", lineAtPick: 20.5, lineAtClose: 19.5 }), // +1 beat
      pick({ id: "b", side: "more", lineAtPick: 14.5, lineAtClose: 15.5 }), // -1 miss
      pick({ id: "c", side: "less", lineAtPick: 19.5, lineAtClose: 21 }), // +1.5 beat
      pick({ id: "d" }), // no close yet -> tracked but not closed
    ]);
    assert.equal(s.tracked, 4);
    assert.equal(s.closed, 3);
    assert.equal(s.beatClose, 2);
    assert.equal(s.beatRate, 2 / 3);
    assert.equal(s.avgClvPoints, Math.round(((1 - 1 + 1.5) / 3) * 100) / 100);
  });

  it("reports null rates when nothing has closed", () => {
    const s = summarizeClv([pick({}), pick({ id: "z" })]);
    assert.equal(s.closed, 0);
    assert.equal(s.beatRate, null);
    assert.equal(s.avgClvPoints, null);
  });
});
