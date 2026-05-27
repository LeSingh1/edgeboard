import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "./pipeline";
import { _resetRegistryForTests, registerAdapter } from "@/lib/sports/registry";
import type { SportAdapter, RawGame } from "@/lib/sports/types";

const stub = (league: string, fail = false): SportAdapter => ({
  leagues: [league], displayName: league, trainingSeasons: () => [2026],
  supportedStats: ["Points"],
  fetchPlayerRoster: async () => fail ? (() => { throw new Error(`${league} boom`); })() : [{ id: "p1", name: "P", team: "T" }],
  fetchPlayerGamelog: async () => Array.from({ length: 600 }, (_, i): RawGame => ({
    eventId: `e${i}`, gameDate: "2026-05-01", stats: { Points: 10 + (i % 20) },
  })),
  fetchTeamSchedule: async () => [],
  extractStat: (g, s) => Number(g.stats[s] ?? null),
  project: async () => ({ available: false, reason: "n/a" }),
});

describe("runPipeline", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "edgeboard-pipe-"));
    _resetRegistryForTests();
  });

  it("runs all registered adapters and returns a summary", async () => {
    registerAdapter(stub("LG1"));
    registerAdapter(stub("LG2"));
    const summary = await runPipeline({ rootDir: root, minBucketSize: 100, maxConcurrent: 2 });
    assert.equal(summary.results.length, 2);
    assert.equal(summary.okCount, 2);
    assert.equal(summary.failedCount, 0);
  });

  it("isolates failures — one bad adapter doesn't kill the others", async () => {
    registerAdapter(stub("LG1"));
    registerAdapter(stub("LG2", true));
    registerAdapter(stub("LG3"));
    const summary = await runPipeline({ rootDir: root, minBucketSize: 100, maxConcurrent: 2 });
    assert.equal(summary.okCount, 2);
    assert.equal(summary.failedCount, 1);
    assert.match(summary.results.find(r => r.sport === "LG2")?.error ?? "", /boom/);
  });
});
