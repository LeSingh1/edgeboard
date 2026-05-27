import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerAdapter, getAdapterFor, allAdapters, _resetRegistryForTests } from "./registry";
import type { SportAdapter } from "./types";

const stub = (leagues: string[]): SportAdapter => ({
  leagues,
  displayName: "Stub",
  trainingSeasons: () => [2026],
  supportedStats: [],
  fetchPlayerRoster: async () => [],
  fetchPlayerGamelog: async () => [],
  fetchTeamSchedule: async () => [],
  extractStat: () => null,
  project: async () => ({ available: false, reason: "stub" }),
});

describe("sport registry", () => {
  it("looks up adapter by league name", () => {
    _resetRegistryForTests();
    const a = stub(["NBA", "NBA1Q", "NBA1H"]);
    registerAdapter(a);
    assert.strictEqual(getAdapterFor("NBA"), a);
    assert.strictEqual(getAdapterFor("NBA1Q"), a);
    assert.strictEqual(getAdapterFor("NHL"), null);
  });

  it("rejects double-registration of the same league", () => {
    _resetRegistryForTests();
    registerAdapter(stub(["NBA"]));
    assert.throws(() => registerAdapter(stub(["NBA"])), /already registered/);
  });

  it("returns all registered adapters once each", () => {
    _resetRegistryForTests();
    const a = stub(["NBA", "NBA1Q"]);
    const b = stub(["NHL"]);
    registerAdapter(a);
    registerAdapter(b);
    assert.deepStrictEqual(allAdapters(), [a, b]);
  });
});
