import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  signatureFor,
  applyCachedPricing,
  __resetBoardPricingCache,
} from "./boardPricing";
import type { Prop } from "./types";

function mkProp(over: Partial<Prop>): Prop {
  return {
    id: "pp-1",
    source: "prizepicks",
    sport: "NBA",
    league: "NBA",
    playerName: "Jarrett Allen",
    team: "CLE",
    opponent: "NYK",
    gameTime: "2026-06-03T23:00:00Z",
    statType: "Points",
    line: 12.5,
    status: "active",
    oddsType: "standard",
    pMore: 0.5,
    pLess: 0.5,
    modelVersion: "implied-v1",
    ...over,
  };
}

describe("signatureFor", () => {
  beforeEach(() => __resetBoardPricingCache());

  it("is stable across PrizePicks id churn (same semantics → same key)", () => {
    const a = mkProp({ id: "pp-111" });
    const b = mkProp({ id: "pp-999" }); // different pull id, same prop
    assert.equal(signatureFor(a), signatureFor(b));
  });

  it("separates by line, oddsType, and game", () => {
    const base = mkProp({});
    assert.notEqual(signatureFor(base), signatureFor(mkProp({ line: 13.5 })));
    assert.notEqual(signatureFor(base), signatureFor(mkProp({ oddsType: "demon" })));
    assert.notEqual(signatureFor(base), signatureFor(mkProp({ gameTime: "2026-06-04T23:00:00Z" })));
  });
});

describe("applyCachedPricing — fallback safety", () => {
  beforeEach(() => __resetBoardPricingCache());

  it("leaves the implied fallback untouched on a cold cache (never breaks the board)", () => {
    const props = [
      mkProp({ id: "pp-1", oddsType: "demon", pMore: 0.4, pLess: 0.6, modelVersion: "implied-v1" }),
      mkProp({ id: "pp-2", oddsType: "standard", pMore: 0.5, pLess: 0.5, modelVersion: "implied-v1" }),
    ];
    const { props: out, pricedByModel, total } = applyCachedPricing(props);
    assert.equal(total, 2);
    assert.equal(pricedByModel, 0); // nothing warmed yet
    assert.equal(out[0].pMore, 0.4); // demon keeps its implied value
    assert.equal(out[0].modelVersion, "implied-v1");
    assert.equal(out[1].pMore, 0.5);
  });

  it("never mutates the input props (cache miss passes the prop through unchanged)", () => {
    const p = mkProp({ pMore: 0.42, pLess: 0.58 });
    const snapshot = { ...p };
    applyCachedPricing([p]);
    assert.deepEqual(p, snapshot); // input object untouched
  });
});
