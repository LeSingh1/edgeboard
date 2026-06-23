/**
 * No-mock-data gate — picks may only ever be built from real-model-priced props.
 * Covers: league coverage, the modelVersion signal, the buildAutoLineups gate,
 * and the optimize() gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLiveProjectionLeague, LIVE_PROJECTION_BASE_LEAGUES, isBlockedSport, isModelStale, MAX_MODEL_AGE_DAYS } from "./projectionCoverage";
import { hasRealModel, IMPLIED_MODEL_VERSION } from "./projectionModel";
import { SOCCER_LIVE } from "./sports/espnLiveProjection";
import { buildResult } from "./realProjections";
import { calibrateSoccer } from "./sports/soccer/calibrate";
import type { SportArtifacts } from "./sports/types";
import { buildAutoLineups } from "./autoPilot";
import { optimize, isUpcoming, withinBetHorizon } from "./optimizer";
import "./sports/registerAll";
import { allAdapters } from "./sports/registry";
import type { Prop } from "./types";
import type { ProjectionResult } from "./realProjections";

const proj = (o: Record<string, unknown>): ProjectionResult => o as unknown as ProjectionResult;

function mkProp(over: Partial<Prop>): Prop {
  return {
    id: "x", source: "prizepicks", sport: "NBA", league: "NBA",
    playerName: "Test Player", team: "AAA", opponent: "BBB",
    gameTime: new Date(Date.now() + 36 * 3600 * 1000).toISOString(), statType: "Points", line: 20.5, // ~1.5 days out: upcoming + within bet horizon
    status: "active", oddsType: "standard", pMore: 0.5, pLess: 0.5,
    modelVersion: "nba-espn-v1+iso", // real by default
    ...over,
  };
}

describe("isLiveProjectionLeague — only inlined-model leagues are covered", () => {
  it("covers NBA / WNBA / MLB / NHL / NFL / WORLD CUP and their segments", () => {
    for (const l of ["NBA", "WNBA", "MLB", "NHL", "NFL", "WORLD CUP", "nba", "NBA1Q", "WNBA1H", "WNBA1Q", "MLBLIVE", "NHL1P"]) {
      assert.equal(isLiveProjectionLeague(l), true, `${l} should be covered`);
    }
  });
  it("rejects every league without a real projection model (incl. NFLSZN season totals)", () => {
    for (const l of ["BAD", "CS2", "TENNIS", "PGA", "LoL", "NPB", "COD", "F1", "NBA2K", "NFLSZN"]) {
      assert.equal(isLiveProjectionLeague(l), false, `${l} must NOT be covered`);
    }
  });
  it("handles null/empty", () => {
    assert.equal(isLiveProjectionLeague(undefined), false);
    assert.equal(isLiveProjectionLeague(""), false);
  });
  it("base-league list is exactly the genuinely-inlined sports", () => {
    assert.deepEqual([...LIVE_PROJECTION_BASE_LEAGUES], ["NBA", "WNBA", "MLB", "NHL", "NFL", "WORLD CUP"]);
  });

  it("coverage list matches exactly the leagues served by hasLiveProjection adapters (no drift)", () => {
    // The single source of truth: a base league is gate-eligible iff some adapter
    // declaring hasLiveProjection actually serves it. (Matched by league, not by
    // displayName, because one adapter can serve several leagues — the soccer
    // adapter serves both "SOCCER" and the gate-eligible "WORLD CUP".) If someone
    // inlines a sport and flips the flag, this fails until the league is added to
    // LIVE_PROJECTION_BASE_LEAGUES too — and vice versa — so the gate can never
    // silently include an un-inlined sport.
    const base = new Set<string>(LIVE_PROJECTION_BASE_LEAGUES);
    const served = new Set<string>();
    for (const a of allAdapters()) {
      if (!a.hasLiveProjection) continue;
      for (const lg of a.leagues) if (base.has(lg.toUpperCase())) served.add(lg.toUpperCase());
    }
    assert.deepEqual([...served].sort(), [...LIVE_PROJECTION_BASE_LEAGUES].sort());
  });
});

describe("isBlockedSport — hard no-bet list", () => {
  it("NPB is blocked", () => {
    assert.equal(isBlockedSport("NPB"), true);
    assert.equal(isBlockedSport("npb"), true);
  });
  it("live-projection leagues are not blocked", () => {
    for (const l of LIVE_PROJECTION_BASE_LEAGUES) {
      assert.equal(isBlockedSport(l), false, `${l} must not be blocked`);
    }
  });
  it("handles null/empty", () => {
    assert.equal(isBlockedSport(undefined), false);
    assert.equal(isBlockedSport(""), false);
  });
});

describe("isModelStale — stale models don't get bet (World Cup wrong-picks fix)", () => {
  const NOW = Date.parse("2026-06-22T20:00:00Z");
  it("flags a model older than the max age (soccer at ~11 days)", () => {
    assert.equal(isModelStale("2026-06-12T07:10:00Z", NOW), true);
  });
  it("passes a fresh model (retrained today)", () => {
    assert.equal(isModelStale("2026-06-22T14:32:00Z", NOW), false);
  });
  it("does not block on missing/invalid timestamps", () => {
    assert.equal(isModelStale(undefined, NOW), false);
    assert.equal(isModelStale("", NOW), false);
    assert.equal(isModelStale("not-a-date", NOW), false);
  });
  it("uses a sane default threshold (a few days, not hours)", () => {
    assert.ok(MAX_MODEL_AGE_DAYS >= 2 && MAX_MODEL_AGE_DAYS <= 10);
  });
});

describe("buildResult — certainty gate: no pick from a player who didn't play", () => {
  it("excludes a player with all-zero recent games (likely did not play)", () => {
    // Observed bug: Angus Gunn Goalie Saves [0,0,0,0,0,0,0,0,0,0] → projected 0 →
    // clamped to a false 90% 'under'. No real activity = not certain = exclude.
    const r = buildResult([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3.5, "test", "soccer-espn-live-v1");
    assert.equal(r.available, false);
  });
  it("excludes a player active earlier but zero in recent games (stale projection)", () => {
    // Observed bug: Max Crocombe Goalie Saves [.., 0,0,0,0,0,0,0,0,0,0] — older
    // games projected 1.17 but the last games are all 0 (not in the lineup), which
    // made a false "88% under 3.5". Recent inactivity must exclude regardless of
    // older activity.
    const r = buildResult([4, 3, 5, 2, 4, 0, 0, 0, 0, 0], 3.5, "test", "soccer-espn-live-v1");
    assert.equal(r.available, false);
  });
  it("excludes a backup/rotation player with too few active games (DNP-polluted)", () => {
    // Observed bug: Ørjan Nyland Goalie Saves [0,0,0,0,0,0,0,0,0,2] → proj 0.25 →
    // a fake "91% under 2.5". One active game in ten = he barely plays; the zeros
    // are DNPs, not a real low-save rate. Not certain he plays = exclude.
    const r = buildResult([0, 0, 0, 0, 0, 0, 0, 0, 0, 2], 2.5, "test", "soccer-espn-live-v1");
    assert.equal(r.available, false);
  });
  it("still prices a player with current activity (older zeros are fine)", () => {
    const r = buildResult([0, 0, 1, 1, 0, 2, 5, 1, 2, 4], 3.5, "test", "soccer-espn-live-v1");
    assert.equal(r.available, true);
    if (r.available) assert.ok(r.projection > 0, "real recent saves → non-zero projection");
  });
  it("still enforces the minimum-games floor", () => {
    assert.equal(buildResult([1, 2, 3], 1.5, "test", "v1").available, false);
  });
});

describe("calibrateSoccer — World Cup bets ONLY what the trained model covers", () => {
  // Trained soccer model covers Goals/Assists/Fouls/Saves/Goals Allowed, standard
  // only — NOT Shots/SOT, and no goblin/demon. "If it isn't trained, don't bet."
  const arts = {
    calibration: { buckets: { "Goals|standard": { x: [0.05, 0.5, 0.95], y: [0.08, 0.45, 0.9], sampleSize: 1000 } } },
  } as unknown as SportArtifacts;
  const raw: ProjectionResult = {
    available: true, pMore: 0.6, pLess: 0.4, projection: 1, sigma: 1,
    sampleSize: 10, recent: [1, 0, 2, 1, 0], source: "test", modelVersion: "soccer-espn-live-v1",
  };
  it("excludes an untrained stat (Shots / SOT have no bucket)", () => {
    assert.equal(calibrateSoccer(raw, mkProp({ statType: "Shots", oddsType: "standard" }), arts).available, false);
    assert.equal(calibrateSoccer(raw, mkProp({ statType: "SOT", oddsType: "standard" }), arts).available, false);
  });
  it("excludes an untrained rung (only standard is trained)", () => {
    assert.equal(calibrateSoccer(raw, mkProp({ statType: "Goals", oddsType: "demon" }), arts).available, false);
    assert.equal(calibrateSoccer(raw, mkProp({ statType: "Goals", oddsType: "goblin" }), arts).available, false);
  });
  it("prices a trained standard stat with the trained-v2 calibration applied", () => {
    const r = calibrateSoccer(raw, mkProp({ statType: "Goals", oddsType: "standard" }), arts);
    assert.equal(r.available, true);
    if (r.available) assert.equal(r.modelVersion, "soccer-trained-v2");
  });
  it("excludes everything when the trained model isn't loaded", () => {
    const r = calibrateSoccer(raw, mkProp({ statType: "Goals", oddsType: "standard" }), { calibration: null } as unknown as SportArtifacts);
    assert.equal(r.available, false);
  });
});

describe("SOCCER_LIVE — World Cup stat mapping reads the real ESPN gamelog labels", () => {
  // ESPN soccer/all gamelog labels (verified live against real players):
  //   field player: G A SHOT SOG FC FA OF YC RC
  //   goalkeeper:   CS SV GA G A FC FA YC RC
  const field = { labels: ["G", "A", "SHOT", "SOG", "FC", "FA", "OF", "YC", "RC"], row: ["2", "1", "5", "3", "1", "2", "0", "1", "0"] };
  const keeper = { labels: ["CS", "SV", "GA", "G", "A", "FC", "FA", "YC", "RC"], row: ["0", "4", "1", "0", "0", "0", "1", "0", "0"] };
  const read = (stat: string, src: { labels: string[]; row: string[] }) =>
    SOCCER_LIVE.stats[stat]?.(src.row, src.labels) ?? null;

  it("maps field stats to the right columns", () => {
    assert.equal(read("Goals", field), 2);
    assert.equal(read("Assists", field), 1);
    assert.equal(read("Shots", field), 5);
    assert.equal(read("SOT", field), 3);
    assert.equal(read("Shots on Target", field), 3);
    assert.equal(read("Fouls Drawn", field), 2); // FA
    assert.equal(read("Fouls Committed", field), 1); // FC
    assert.equal(read("Goals+Assists", field), 3);
  });
  it("maps goalkeeper stats and yields null for absent columns (excluded, not faked)", () => {
    assert.equal(read("Goalie Saves", keeper), 4);
    assert.equal(read("Goals Allowed", keeper), 1);
    // A keeper has no SHOT column → Shots is null → the no-mock gate drops it.
    assert.equal(read("Shots", keeper), null);
    // A field player has no SV column → Saves is null.
    assert.equal(read("Saves", field), null);
  });
  it("uses a real (non-implied) modelVersion so picks pass the no-mock gate", () => {
    assert.equal(hasRealModel(SOCCER_LIVE.modelVersion), true);
  });
});

describe("optimize — BLOCKED_SPORTS hard excluded even with requireRealModel false", () => {
  it("NPB props never enter a slip regardless of requireRealModel", () => {
    const props: Prop[] = [
      mkProp({ id: "nba1", playerName: "NBA One", team: "AAA", pMore: 0.7, pLess: 0.3 }),
      mkProp({ id: "nba2", playerName: "NBA Two", team: "BBB", pMore: 0.7, pLess: 0.3 }),
      mkProp({ id: "npb1", sport: "NPB", league: "NPB", playerName: "NPB Pitcher", team: "CCC", pMore: 0.9, pLess: 0.1, modelVersion: "real-outcomes-v1" }),
    ];
    const { lineups } = optimize({ selectedProps: props, lineupSize: 2, entryCost: 10, riskMode: "safe", requireRealModel: false });
    const ids = new Set(lineups.flatMap((l) => l.picks.map((p) => p.prop.id)));
    assert.equal(ids.has("npb1"), false, "NPB prop must never appear in any slip");
    assert.ok(lineups.length > 0, "the two NBA props still form a slip");
  });
});

describe("buildAutoLineups — BLOCKED_SPORTS hard excluded", () => {
  it("NPB props never enter the pool even if requireRealModel is false", () => {
    const props: Prop[] = [
      mkProp({ id: "n1", playerName: "A", team: "AAA", statType: "Points", line: 10.5 }),
      mkProp({ id: "n2", playerName: "B", team: "BBB", statType: "Rebounds", line: 6.5 }),
      mkProp({ id: "np1", sport: "NPB", league: "NPB", playerName: "Pitcher", team: "CCC", statType: "Hits", line: 0.5, modelVersion: "real-outcomes-v1" }),
    ];
    const real = {
      n1: proj({ available: true, pMore: 0.7, pLess: 0.3, projection: 13, sigma: 3, recent: [11, 12, 13, 14, 12] }),
      n2: proj({ available: true, pMore: 0.7, pLess: 0.3, projection: 8, sigma: 2, recent: [7, 8, 9, 7, 8] }),
      np1: proj({ available: true, pMore: 0.9, pLess: 0.1, projection: 1, sigma: 0.5, recent: [1, 1, 1, 1, 1] }),
    };
    const r = buildAutoLineups(props, 2, 3, 5, { sport: "ALL", realProjections: real, requireRealModel: false });
    const ids = new Set(r.lineups.flatMap((l) => l.picks.map((p) => p.prop.id)));
    assert.equal(ids.has("np1"), false, "NPB must never enter a lineup");
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
  it("excludes uncovered-league props entirely (no Tennis / badminton picks)", () => {
    const props: Prop[] = [
      mkProp({ id: "tn1", sport: "TENNIS", league: "TENNIS", playerName: "Player A", team: "ESP", statType: "Aces", line: 7.5, modelVersion: IMPLIED_MODEL_VERSION }),
      mkProp({ id: "tn2", sport: "TENNIS", league: "TENNIS", playerName: "Player B", team: "USA", statType: "Aces", line: 6.5, modelVersion: IMPLIED_MODEL_VERSION }),
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

describe("betting-horizon filter — no picks on games more than 3 days out", () => {
  const NOW = Date.parse("2026-06-13T18:00:00Z");
  const at = (iso: string, id = "x") => mkProp({ id, gameTime: iso });

  it("withinBetHorizon: within 3 days → true, beyond → false, bad/missing → true", () => {
    assert.equal(withinBetHorizon(at("2026-06-14T18:00:00Z"), NOW), true); // +1 day
    assert.equal(withinBetHorizon(at("2026-06-16T17:00:00Z"), NOW), true); // +2.96 days
    assert.equal(withinBetHorizon(at("2026-06-16T19:00:00Z"), NOW), false); // +3.04 days
    assert.equal(withinBetHorizon(at("2026-06-20T18:00:00Z"), NOW), false); // +7 days
    assert.equal(withinBetHorizon(mkProp({ gameTime: "" }), NOW), true); // unknown → kept
  });

  it("buildAutoLineups drops a game more than 3 days out, keeps a near one", () => {
    const real = {
      soon1: proj({ available: true, pMore: 0.7, pLess: 0.3, projection: 13, sigma: 3, recent: [11, 12, 13, 14, 12] }),
      soon2: proj({ available: true, pMore: 0.7, pLess: 0.3, projection: 8, sigma: 2, recent: [7, 8, 9, 7, 8] }),
      far1: proj({ available: true, pMore: 0.9, pLess: 0.1, projection: 9, sigma: 2, recent: [8, 9, 10, 9, 8] }),
    };
    const props = [
      mkProp({ id: "soon1", playerName: "Soon A", team: "AAA", statType: "Points", line: 10.5, gameTime: "2026-06-14T23:00:00Z" }),
      mkProp({ id: "soon2", playerName: "Soon B", team: "BBB", statType: "Rebounds", line: 6.5, gameTime: "2026-06-14T23:00:00Z" }),
      mkProp({ id: "far1", playerName: "Far Away", team: "CCC", statType: "Assists", line: 4.5, gameTime: "2026-06-19T23:00:00Z" }),
    ];
    const r = buildAutoLineups(props, 2, 3, 5, { sport: "ALL", realProjections: real, now: NOW });
    const ids = new Set(r.lineups.flatMap((l) => l.picks.map((p) => p.prop.id)));
    assert.equal(ids.has("far1"), false, "a game 6 days out must never be a pick");
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
