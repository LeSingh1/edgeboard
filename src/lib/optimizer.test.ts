import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combinations, oddsPayoutFactor, optimize, enterablePick } from "./optimizer";
import type { Prop } from "./types";

/** Minimal valid Prop; override per case. */
function mkProp(over: Partial<Prop>): Prop {
  return {
    id: "x",
    source: "mock",
    sport: "NBA",
    league: "NBA",
    playerName: "Test Player",
    team: "AAA",
    opponent: "BBB",
    gameTime: new Date(Date.now() + 36 * 3600 * 1000).toISOString(), // ~1.5 days out: upcoming AND within the 3-day bet horizon
    statType: "Points",
    line: 20.5,
    status: "active",
    oddsType: "standard",
    pMore: 0.5,
    pLess: 0.5,
    modelVersion: "test",
    ...over,
  };
}

describe("combinations — full coverage", () => {
  it("yields all C(n,k) subsets, not a skewed subset", () => {
    const c2 = [...combinations(["a", "b", "c", "d"], 2)].map((c) => c.join(""));
    assert.equal(c2.length, 6);
    for (const want of ["ab", "ac", "ad", "bc", "bd", "cd"]) {
      assert.ok(c2.includes(want), `missing pair ${want} (got ${c2.join(",")})`);
    }
  });

  it("yields singletons including the first element (the old bug)", () => {
    const c1 = [...combinations(["a", "b", "c"], 1)].map((c) => c.join("")).sort();
    assert.deepEqual(c1, ["a", "b", "c"]);
  });
});

describe("oddsPayoutFactor — additive stacking", () => {
  it("leaves single demon / goblin / standard unchanged", () => {
    assert.equal(oddsPayoutFactor([mkProp({ oddsType: "demon" })]), 1.5);
    assert.equal(oddsPayoutFactor([mkProp({ oddsType: "goblin" })]), 0.85);
    assert.equal(oddsPayoutFactor([mkProp({ oddsType: "standard" })]), 1.0);
  });

  it("stacks two demons additively to 2.0 (was 2.25 multiplicative)", () => {
    const f = oddsPayoutFactor([
      mkProp({ oddsType: "demon" }),
      mkProp({ oddsType: "demon" }),
    ]);
    assert.equal(f, 2.0);
    assert.notEqual(f, 2.25); // the old multiplicative over-credit is gone
  });

  it("stacks two goblins additively to ~0.70", () => {
    const f = oddsPayoutFactor([
      mkProp({ oddsType: "goblin" }),
      mkProp({ oddsType: "goblin" }),
    ]);
    assert.ok(Math.abs(f - 0.7) < 1e-9, `expected ~0.70, got ${f}`);
  });

  it("mixes demon + goblin additively (1 + 0.5 - 0.15 = 1.35)", () => {
    const f = oddsPayoutFactor([
      mkProp({ oddsType: "demon" }),
      mkProp({ oddsType: "goblin" }),
    ]);
    assert.ok(Math.abs(f - 1.35) < 1e-9, `expected 1.35, got ${f}`);
  });

  it("floors at 0.1 so a deep all-goblin slip can't zero the payout", () => {
    const tenGoblins = Array.from({ length: 10 }, () => mkProp({ oddsType: "goblin" }));
    assert.equal(oddsPayoutFactor(tenGoblins), 0.1);
  });
});

describe("optimizer — demon bias regression", () => {
  // With REAL model probabilities (demon overs priced at their true low hit
  // rate), the optimizer must NOT surface an all-demon slip above a sane
  // standard slip purely because demons pay more. This is the exact behavior
  // the user reported ("always favors red demons even though they rarely hit").
  it("does not rank an all-demon slip first when demons are priced low", () => {
    const props: Prop[] = [
      // Two strong standard legs (model likes the over)
      mkProp({ id: "s1", playerName: "Std One", team: "AAA", oddsType: "standard", pMore: 0.62, pLess: 0.38 }),
      mkProp({ id: "s2", playerName: "Std Two", team: "BBB", oddsType: "standard", pMore: 0.62, pLess: 0.38 }),
      // Two demon legs the model thinks are unlikely to hit
      mkProp({ id: "d1", playerName: "Demon One", team: "CCC", oddsType: "demon", pMore: 0.30, pLess: 0.70 }),
      mkProp({ id: "d2", playerName: "Demon Two", team: "DDD", oddsType: "demon", pMore: 0.30, pLess: 0.70 }),
    ];

    const { lineups } = optimize({
      selectedProps: props,
      lineupSize: 2,
      entryCost: 10,
      riskMode: "aggressive", // pure-EV sort — the harshest test for a demon bias
    });

    assert.ok(lineups.length > 0, "expected at least one lineup");
    const top = lineups[0];
    const demonCount = top.picks.filter((p) => p.prop.oddsType === "demon").length;
    assert.equal(demonCount, 0, "top EV lineup should be the standard pair, not demons");
    assert.ok(top.expectedValue > 0, "the chosen standard slip should be +EV");
  });

  it("still allows demons when their real probability justifies the payout", () => {
    // A demon the model genuinely likes (0.55) SHOULD be competitive — the fix
    // removes the *structural* bias, it doesn't ban demons outright.
    const props: Prop[] = [
      mkProp({ id: "s1", playerName: "Std One", team: "AAA", oddsType: "standard", pMore: 0.50, pLess: 0.50 }),
      mkProp({ id: "d1", playerName: "Demon Hot", team: "BBB", oddsType: "demon", pMore: 0.55, pLess: 0.45 }),
    ];
    const { lineups } = optimize({
      selectedProps: props,
      lineupSize: 2,
      entryCost: 10,
      riskMode: "aggressive",
    });
    // Only one 2-combo exists (s1 + d1); just assert it's evaluated and the
    // demon leg is priced on its real prob, not a flat constant.
    assert.equal(lineups.length > 0, true);
    const demon = lineups[0].picks.find((p) => p.prop.oddsType === "demon");
    assert.ok(demon, "demon leg should be present in the only valid combo");
    assert.equal(demon!.probability, 0.55, "demon must use its real pMore, not 0.40");
  });
});

describe("probProfit — honest 'chance you actually profit'", () => {
  it("equals hit probability for a Power play (all-or-nothing, multiplier > 1)", () => {
    const props: Prop[] = [
      mkProp({ id: "a", playerName: "A", team: "AAA", pMore: 0.6, pLess: 0.4 }),
      mkProp({ id: "b", playerName: "B", team: "BBB", pMore: 0.6, pLess: 0.4 }),
    ];
    const { lineups } = optimize({
      selectedProps: props, lineupSize: 2, entryCost: 10, riskMode: "safe", playType: "power",
    });
    const power = lineups.find((l) => l.playType === "power");
    assert.ok(power, "expected a power lineup");
    assert.equal(power!.probProfit, power!.hitProbability);
  });

  it("excludes the break-even/loss Flex tier (3/3 profits, 2/3 only cashes)", () => {
    const props: Prop[] = [
      mkProp({ id: "a", playerName: "A", team: "AAA", pMore: 0.6, pLess: 0.4 }),
      mkProp({ id: "b", playerName: "B", team: "BBB", pMore: 0.6, pLess: 0.4 }),
      mkProp({ id: "c", playerName: "C", team: "CCC", pMore: 0.6, pLess: 0.4 }),
    ];
    const { lineups } = optimize({
      selectedProps: props, lineupSize: 3, entryCost: 10, riskMode: "safe", playType: "flex",
    });
    const flex = lineups.find((l) => l.playType === "flex");
    assert.ok(flex, "expected a flex lineup");
    // 3 picks @ 0.6: P(>=2 of 3) = 0.648 cashes; but the 2/3 tier pays 1.0x
    // (break-even, NOT profit), so probProfit = P(3/3) = 0.216 only.
    assert.ok(Math.abs(flex!.hitProbability - 0.648) < 1e-6, `hit ${flex!.hitProbability}`);
    assert.ok(Math.abs((flex!.probProfit ?? -1) - 0.216) < 1e-6, `probProfit ${flex!.probProfit}`);
    assert.ok(flex!.probProfit! < flex!.hitProbability, "profit prob must be below cash prob");
  });
});

describe("enterablePick — MORE-only invariant for demon/goblin", () => {
  it("flips a stale demon LESS to MORE and uses pMore (the real, low prob)", () => {
    const demon = mkProp({ oddsType: "demon", pMore: 0.05, pLess: 0.95 });
    const r = enterablePick(demon, "less", 0.95);
    assert.equal(r.side, "more", "demon must normalize to MORE");
    assert.equal(r.repriced, true, "must flag the flip");
    assert.ok(Math.abs(r.probability - 0.05) < 1e-9, `expected pMore 0.05, got ${r.probability}`);
  });

  it("flips a stale goblin LESS to MORE", () => {
    const goblin = mkProp({ oddsType: "goblin", pMore: 0.62, pLess: 0.38 });
    const r = enterablePick(goblin, "less", 0.38);
    assert.equal(r.side, "more");
    assert.equal(r.repriced, true);
    assert.ok(Math.abs(r.probability - 0.62) < 1e-9);
  });

  it("leaves a demon already on MORE untouched", () => {
    const demon = mkProp({ oddsType: "demon", pMore: 0.4, pLess: 0.6 });
    const r = enterablePick(demon, "more", 0.4);
    assert.equal(r.side, "more");
    assert.equal(r.repriced, false);
    assert.equal(r.probability, 0.4);
  });

  it("passes standard picks through on EITHER side (both are enterable)", () => {
    const std = mkProp({ oddsType: "standard", pMore: 0.45, pLess: 0.55 });
    const less = enterablePick(std, "less", 0.55);
    assert.equal(less.side, "less");
    assert.equal(less.repriced, false);
    assert.equal(less.probability, 0.55);
    const more = enterablePick(std, "more", 0.45);
    assert.equal(more.side, "more");
    assert.equal(more.repriced, false);
  });

  it("falls back to 1 - storedProb when pMore is missing", () => {
    const demon = mkProp({ oddsType: "demon", pMore: NaN, pLess: 0.9 });
    const r = enterablePick(demon, "less", 0.9);
    assert.equal(r.side, "more");
    assert.ok(Math.abs(r.probability - 0.1) < 1e-9, `expected 0.1 fallback, got ${r.probability}`);
  });
});
