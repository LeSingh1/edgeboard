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
    gameTime: "2099-06-06T23:00:00Z", // far-future so the game-started filter keeps the fixture
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

/**
 * Regression tests for "Red demons mode returns goblin/standard slips".
 *
 * Real failure (WNBA, 2026-06-11): with a warm projection cache the pass-2
 * rebuild pool mixes real-priced demons (pMore ≈ 0.23–0.38) with cached
 * goblins/standards (pMore ≥ 0.55). Three things then conspired:
 *   1. families whose demon variant wasn't in the pool silently substituted
 *      their goblin/standard variant (bestVariant fell through to best-prob);
 *   2. the relaxed demon floor (0.30) was tuned for the 0.40 implied
 *      placeholder, so most REAL-priced demons were dropped;
 *   3. the optimizer ranks lineups by hit probability, so the surviving mixed
 *      pool always put goblin/standard slips first.
 * Net: the user picked Red Demons and got goblin slips.
 */
describe("buildAutoLineups — explicit pick-style preference is binding", () => {
  /** A family = demon + standard rungs; or goblin + standard. All .5 lines. */
  const real: Record<string, import("./realProjections").ProjectionResult> = {};
  const props: Prop[] = [];
  const TEAMS = ["LVA", "NYL", "IND", "CHI", "SEA", "MIN", "PHX", "ATL"];
  const addFamily = (
    n: number,
    player: string,
    demonP: number | null,
    goblinP: number | null,
    standardP: number,
  ) => {
    // Spread families across teams — PrizePicks slips need >= 2 distinct teams.
    const fam = {
      playerName: player,
      statType: "Points",
      team: TEAMS[(n - 1) % TEAMS.length],
      opponent: TEAMS[n % TEAMS.length],
    };
    if (demonP !== null) {
      const id = `d${n}`;
      props.push(mkProp({ ...fam, id, oddsType: "demon", line: 30.5, pMore: 0.4, pLess: 0.6 }));
      real[id] = { available: true, pMore: demonP, pLess: 1 - demonP, projection: 25, sigma: 6, sampleSize: 20, recent: [], source: "test", modelVersion: "test-v1" };
    }
    if (goblinP !== null) {
      const id = `g${n}`;
      props.push(mkProp({ ...fam, id, oddsType: "goblin", line: 14.5, pMore: 0.588, pLess: 0.412 }));
      real[id] = { available: true, pMore: goblinP, pLess: 1 - goblinP, projection: 25, sigma: 6, sampleSize: 20, recent: [], source: "test", modelVersion: "test-v1" };
    }
    const id = `s${n}`;
    props.push(mkProp({ ...fam, id, oddsType: "standard", line: 22.5, pMore: standardP, pLess: 1 - standardP }));
    real[id] = { available: true, pMore: standardP, pLess: 1 - standardP, projection: 25, sigma: 6, sampleSize: 20, recent: [], source: "test", modelVersion: "test-v1" };
  };
  // 4 families WITH demons, real-priced where demons actually price (0.22–0.34).
  addFamily(1, "Demon A", 0.34, null, 0.56);
  addFamily(2, "Demon B", 0.28, null, 0.58);
  addFamily(3, "Demon C", 0.25, null, 0.6);
  addFamily(4, "Demon D", 0.22, null, 0.55);
  // 4 families WITHOUT demons — easy goblins that outrank any demon on hit prob.
  addFamily(5, "Goblin A", null, 0.7, 0.55);
  addFamily(6, "Goblin B", null, 0.68, 0.56);
  addFamily(7, "Goblin C", null, 0.66, 0.57);
  addFamily(8, "Goblin D", null, 0.64, 0.58);

  it("demon preference builds DEMON slips even when easier picks share the pool", () => {
    const res = buildAutoLineups(props, 2, 3, 5, {
      oddsPreference: "demon",
      realProjections: real,
    });
    assert.ok(res.lineups.length > 0, "should still build slips from the demon material");
    for (const l of res.lineups) {
      for (const pk of l.picks) {
        assert.equal(
          pk.prop.oddsType,
          "demon",
          `Red Demons mode must only play demons, got ${pk.prop.oddsType} (${pk.prop.playerName})`,
        );
      }
    }
  });

  it("demon preference keeps real-priced demons above ~0.2 (floor tuned for real model, not the 0.40 placeholder)", () => {
    const res = buildAutoLineups(props, 2, 3, 5, {
      oddsPreference: "demon",
      realProjections: real,
    });
    const ids = res.candidates.map((c) => c.id);
    assert.ok(ids.includes("d2"), "0.28 demon must survive the floor");
    assert.ok(ids.includes("d3"), "0.25 demon must survive the floor");
  });

  it("families without the wanted variant are skipped, not substituted", () => {
    const res = buildAutoLineups(props, 2, 3, 5, {
      oddsPreference: "demon",
      realProjections: real,
    });
    assert.ok(
      res.candidates.every((c) => c.oddsType === "demon"),
      `pool must be demon-only, got: ${res.candidates.map((c) => c.oddsType).join(",")}`,
    );
  });

  it("standard preference means standard ONLY (the UI copy promises 'no goblins or demons')", () => {
    const res = buildAutoLineups(props, 2, 3, 5, {
      oddsPreference: "standard",
      realProjections: real,
    });
    assert.ok(res.lineups.length > 0);
    for (const l of res.lineups)
      for (const pk of l.picks) assert.equal(pk.prop.oddsType, "standard");
  });

  it("balanced preference still mixes freely (unchanged behavior)", () => {
    const res = buildAutoLineups(props, 2, 3, 5, {
      realProjections: real,
    });
    assert.ok(res.lineups.length > 0);
    const types = new Set(res.candidates.map((c) => c.oddsType));
    assert.ok(types.size > 1, "balanced pool should contain more than one pick style");
  });
});

describe("buildAutoLineups — diversity is player-based (no same-player clones)", () => {
  // Regression for the reported bug: two 2-pick slips came back leading with the
  // SAME player, and the second leg was the SAME player on a different stat
  // ("PRA LESS" vs "PTS+REBS LESS"). The old overlap metric counted prop ids, so
  // a star's alternate-stat prop read as a brand-new pick and the same roster
  // recurred. Overlap is now measured by player, so a slip that reuses both
  // players of an earlier slip is rejected as a clone.
  const real: Record<string, import("./realProjections").ProjectionResult> = {};
  const props: Prop[] = [];
  const teams = ["LVA", "NYL", "IND", "CHI", "SEA", "MIN", "PHX", "ATL"];
  const addPlayer = (i: number, player: string, statType: string, id: string, pMore: number) => {
    props.push(mkProp({
      id, playerName: player, statType, line: 15.5,
      team: teams[i % teams.length], opponent: teams[(i + 1) % teams.length],
      oddsType: "standard", pMore, pLess: 1 - pMore,
    }));
    real[id] = { available: true, pMore, pLess: 1 - pMore, projection: 18, sigma: 4, sampleSize: 20, recent: [], source: "test", modelVersion: "test-v1" };
  };
  // The "star" appears twice on alternate stats — the exact clone trap.
  addPlayer(0, "Star Player", "PRA", "star_pra", 0.82);
  addPlayer(0, "Star Player", "PTS+REBS", "star_ptsrebs", 0.80);
  // Plenty of OTHER distinct players so genuinely different slips are buildable.
  addPlayer(1, "Beta", "Points", "beta", 0.74);
  addPlayer(2, "Gamma", "Points", "gamma", 0.73);
  addPlayer(3, "Delta", "Points", "delta", 0.72);
  addPlayer(4, "Epsilon", "Points", "epsilon", 0.71);
  addPlayer(5, "Zeta", "Points", "zeta", 0.70);

  it("never returns two slips that share both players (no roster clones)", () => {
    const res = buildAutoLineups(props, 2, 3, 5, { realProjections: real });
    assert.ok(res.lineups.length > 1, "the rich pool should support multiple distinct slips");
    for (let a = 0; a < res.lineups.length; a++) {
      for (let b = a + 1; b < res.lineups.length; b++) {
        const pa = new Set(res.lineups[a].picks.map((p) => p.prop.playerName));
        const shared = res.lineups[b].picks.filter((p) => pa.has(p.prop.playerName)).length;
        assert.ok(shared < 2, `slips ${a} and ${b} share ${shared} players — that's a clone`);
      }
    }
  });

  it("does not anchor every slip on the same star (the 'same clips' symptom)", () => {
    const res = buildAutoLineups(props, 2, 3, 5, { realProjections: real });
    // The star may anchor a slip or two (overlap of one player is allowed), but
    // a rich pool must NOT collapse to the same star in every single slip — that
    // is exactly the screenshot's "showing the exact same clips" symptom.
    const slipsWithStar = res.lineups.filter((l) => l.picks.some((p) => p.prop.playerName === "Star Player"));
    assert.ok(
      slipsWithStar.length < res.lineups.length,
      "every slip reused the same star — diversity collapsed",
    );
  });
});
