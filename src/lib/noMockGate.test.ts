/**
 * No-mock-data gate — picks may only ever be built from real-model-priced props.
 * Covers: league coverage, the modelVersion signal, the buildAutoLineups gate,
 * and the optimize() gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLiveProjectionLeague, LIVE_PROJECTION_BASE_LEAGUES } from "./projectionCoverage";
import { hasRealModel, IMPLIED_MODEL_VERSION } from "./projectionModel";
import { buildAutoLineups } from "./autoPilot";
import { optimize, isUpcoming } from "./optimizer";
import "./sports/registerAll";
import { allAdapters } from "./sports/registry";
import type { Prop } from "./types";
import type { ProjectionResult } from "./realProjections";

const proj = (o: Record<string, unknown>): ProjectionResult => o as unknown as ProjectionResult;

function mkProp(over: Partial<Prop>): Prop {
  return {
    id: "x", source: "prizepicks", sport: "NBA", league: "NBA",
    playerName: "Test Player", team: "AAA", opponent: "BBB",
    gameTime: "2099-06-11T23:00:00Z", statType: "Points", line: 20.5, // far-future: game-started filter keeps it
    status: "active", oddsType: "standard", pMore: 0.5, pLess: 0.5,
    modelVersion: "nba-espn-v1+iso", // real by default
    ...over,
  };
}

describe("isLiveProjectionLeague — only inlined-model leagues are covered", () => {
  it("covers NBA / WNBA / MLB / NHL / NFL and their segments", () => {
    for (const l of ["NBA", "WNBA", "MLB", "NHL", "NFL", "nba", "NBA1Q", "WNBA1H", "WNBA1Q", "MLBLIVE", "NHL1P"]) {
      assert.equal(isLiveProjectionLeague(l), true, `${l} should be covered`);
    }
  });
  it("rejects every league without a real projection model (incl. NFLSZN season totals)", () => {
    for (const l of ["WORLD CUP", "BAD", "CS2", "TENNIS", "PGA", "LoL", "NPB", "COD", "F1", "NBA2K", "NFLSZN"]) {
      assert.equal(isLiveProjectionLeague(l), false, `${l} must NOT be covered`);
    }
  });
  it("handles null/empty", () => {
    assert.equal(isLiveProjectionLeague(undefined), false);
    assert.equal(isLiveProjectionLeague(""), false);
  });
  it("base-league list is exactly the genuinely-inlined sports", () => {
    assert.deepEqual([...LIVE_PROJECTION_BASE_LEAGUES], ["NBA", "WNBA", "MLB", "NHL", "NFL"]);
  });

  it("coverage list matches exactly the adapters flagged hasLiveProjection (no drift)", () => {
    // The single source of truth: a league is gate-eligible iff its adapter
    // declares hasLiveProjection. If someone genuinely inlines a sport and flips
    // the flag, this fails until LIVE_PROJECTION_BASE_LEAGUES is updated too —
    // and vice versa, so the gate can never silently include an un-inlined sport.
    const flagged = allAdapters()
      .filter((a) => a.hasLiveProjection)
      .map((a) => a.displayName.toUpperCase())
      .sort();
    assert.deepEqual(flagged, [...LIVE_PROJECTION_BASE_LEAGUES].sort());
  });
});

describe("hasRealModel — the implied placeholder is not a model", () => {
  it("implied-v1 / missing → false", () => {
    assert.equal(hasRealModel(IMPLIED_MODEL_VERSION), false);
    assert.equal(hasRealModel("implied-v1"), false);
    assert.equal(hasRealModel(undefined), false);
    assert.equal(hasRealModel(""), false);
  });
  it("any real model version → true", () => {
    assert.equal(hasRealModel("nba-espn-v1+iso"), true);
    assert.equal(hasRealModel("mlb-rolling-v1"), true);
  });
});

describe("buildAutoLineups — no mock picks", () => {
  it("excludes uncovered-league props entirely (no World Cup / badminton picks)", () => {
    const props: Prop[] = [
      mkProp({ id: "wc1", sport: "WORLD CUP", league: "WORLD CUP", playerName: "Montes", team: "MEX", statType: "Passes Attempted", line: 70.5, modelVersion: IMPLIED_MODEL_VERSION }),
      mkProp({ id: "wc2", sport: "WORLD CUP", league: "WORLD CUP", playerName: "Other", team: "USA", statType: "Passes Attempted", line: 60.5, modelVersion: IMPLIED_MODEL_VERSION }),
      mkProp({ id: "bad1", sport: "BAD", league: "BAD", playerName: "Lin", team: "TPE", statType: "Total Points", line: 78.5, modelVersion: IMPLIED_MODEL_VERSION }),
    ];
    const r = buildAutoLineups(props, 2, 3, 5, { sport: "ALL" });
    assert.equal(r.lineups.length, 0, "no slip should be built from uncovered leagues");
    assert.equal(r.poolSize, 0, "pool must be empty");
  });

  it("drops a covered-league prop whose real projection came back unavailable", () => {
    const props: Prop[] = [
      mkProp({ id: "a", playerName: "A", team: "AAA", statType: "Points", line: 10.5 }),
      mkProp({ id: "b", playerName: "B", team: "BBB", statType: "Rebounds", line: 6.5 }),
      mkProp({ id: "c", playerName: "C", team: "CCC", statType: "Assists", line: 4.5 }),
    ];
    // "c" has a real projection that says unavailable → must never appear.
    const real = {
      a: proj({ available: true, pMore: 0.6, pLess: 0.4, projection: 13, sigma: 3, recent: [11, 12, 13, 14, 12] }),
      b: proj({ available: true, pMore: 0.6, pLess: 0.4, projection: 8, sigma: 2, recent: [7, 8, 9, 7, 8] }),
      c: proj({ available: false, reason: "player not found" }),
    };
    const r = buildAutoLineups(props, 2, 3, 5, { sport: "ALL", realProjections: real });
    const ids = new Set(r.lineups.flatMap((l) => l.picks.map((p) => p.prop.id)));
    assert.equal(ids.has("c"), false, "unavailable prop must be excluded");
  });

  it("requireRealModel:false restores legacy behavior (diagnostics only)", () => {
    const props: Prop[] = [
      mkProp({ id: "wc1", sport: "WORLD CUP", league: "WORLD CUP", team: "MEX", playerName: "M", statType: "X", line: 1.5, oddsType: "goblin", pMore: 0.588, modelVersion: IMPLIED_MODEL_VERSION }),
      mkProp({ id: "wc2", sport: "WORLD CUP", league: "WORLD CUP", team: "USA", playerName: "N", statType: "Y", line: 1.5, oddsType: "goblin", pMore: 0.588, modelVersion: IMPLIED_MODEL_VERSION }),
    ];
    const r = buildAutoLineups(props, 2, 1, 5, { sport: "ALL", requireRealModel: false });
    assert.ok(r.poolSize > 0, "with the gate off, implied props are allowed back in");
  });
});

describe("optimize — no mock slips", () => {
  it("drops implied-v1 props so a slip is never priced on a coinflip", () => {
    const props: Prop[] = [
      mkProp({ id: "real1", playerName: "Real One", team: "AAA", pMore: 0.6, pLess: 0.4 }),
      mkProp({ id: "real2", playerName: "Real Two", team: "BBB", pMore: 0.6, pLess: 0.4 }),
      mkProp({ id: "imp1", playerName: "Implied One", team: "CCC", pMore: 0.5, pLess: 0.5, modelVersion: IMPLIED_MODEL_VERSION }),
    ];
    const { lineups } = optimize({ selectedProps: props, lineupSize: 2, entryCost: 10, riskMode: "safe" });
    const ids = new Set(lineups.flatMap((l) => l.picks.map((p) => p.prop.id)));
    assert.equal(ids.has("imp1"), false, "implied prop must never enter a computed slip");
    assert.ok(lineups.length > 0, "the two real props still form a slip");
  });

  it("all-implied selection yields no slips (not a mock one)", () => {
    const props: Prop[] = [
      mkProp({ id: "i1", team: "AAA", modelVersion: IMPLIED_MODEL_VERSION }),
      mkProp({ id: "i2", team: "BBB", modelVersion: IMPLIED_MODEL_VERSION }),
    ];
    const { lineups } = optimize({ selectedProps: props, lineupSize: 2, entryCost: 10, riskMode: "safe" });
    assert.equal(lineups.length, 0);
  });
});

describe("game-started filter — a stale snapshot never makes a played game pickable", () => {
  // The board can be hours stale (PrizePicks blocks server fetches), leaving a
  // finished game frozen as pre_game. now is pinned so the test is deterministic.
  const NOW = Date.parse("2026-06-13T18:00:00Z");
  const past = (id: string, over: Partial<Prop> = {}) =>
    mkProp({ id, gameTime: "2026-06-13T17:00:00Z", ...over }); // started 1h ago
  const future = (id: string, over: Partial<Prop> = {}) =>
    mkProp({ id, gameTime: "2026-06-13T23:00:00Z", ...over }); // tips off in 5h

  it("isUpcoming: started → false, upcoming → true, bad/missing time → true", () => {
    assert.equal(isUpcoming(past("a"), NOW), false);
    assert.equal(isUpcoming(future("b"), NOW), true);
    assert.equal(isUpcoming(mkProp({ id: "c", gameTime: "" }), NOW), true);
    assert.equal(isUpcoming(mkProp({ id: "d", gameTime: "not-a-date" }), NOW), true);
  });

  it("buildAutoLineups drops the already-started game, keeps the upcoming one", () => {
    const props = [
      future("fut1", { playerName: "Up A", team: "AAA", statType: "Points", line: 10.5 }),
      future("fut2", { playerName: "Up B", team: "BBB", statType: "Rebounds", line: 6.5 }),
      past("done1", { playerName: "Done", team: "CCC", statType: "Assists", line: 4.5 }),
    ];
    const real = {
      fut1: proj({ available: true, pMore: 0.6, pLess: 0.4, projection: 13, sigma: 3, recent: [11, 12, 13, 14, 12] }),
      fut2: proj({ available: true, pMore: 0.6, pLess: 0.4, projection: 8, sigma: 2, recent: [7, 8, 9, 7, 8] }),
      done1: proj({ available: true, pMore: 0.9, pLess: 0.1, projection: 9, sigma: 2, recent: [8, 9, 10, 9, 8] }),
    };
    const r = buildAutoLineups(props, 2, 3, 5, { sport: "ALL", realProjections: real, now: NOW });
    const ids = new Set(r.lineups.flatMap((l) => l.picks.map((p) => p.prop.id)));
    assert.equal(ids.has("done1"), false, "a game that already started must never be a pick");
    assert.ok(r.poolSize > 0 && !ids.has("done1"), "upcoming games still build");
  });

  it("optimize drops a started game from a computed slip", () => {
    const props = [
      future("u1", { playerName: "U1", team: "AAA", pMore: 0.6, pLess: 0.4 }),
      future("u2", { playerName: "U2", team: "BBB", pMore: 0.6, pLess: 0.4 }),
      past("p1", { playerName: "P1", team: "CCC", pMore: 0.6, pLess: 0.4 }),
    ];
    const { lineups } = optimize({ selectedProps: props, lineupSize: 2, entryCost: 10, riskMode: "safe", now: NOW });
    const ids = new Set(lineups.flatMap((l) => l.picks.map((p) => p.prop.id)));
    assert.equal(ids.has("p1"), false, "started game excluded from optimizer slips");
  });
});
