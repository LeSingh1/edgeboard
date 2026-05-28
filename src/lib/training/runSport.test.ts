import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSport } from "./runSport";
import type { SportAdapter, RawGame } from "@/lib/sports/types";

const mockAdapter: SportAdapter = {
  leagues: ["MOCK"],
  displayName: "Mock",
  trainingSeasons: () => [2026],
  supportedStats: ["Points"],
  fetchPlayerRoster: async () => [{ id: "p1", name: "Player One", team: "T" }],
  fetchPlayerGamelog: async () =>
    Array.from({ length: 600 }, (_, i): RawGame => ({
      eventId: `e${i}`,
      gameDate: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      stats: { Points: 10 + (i % 20) },
    })),
  fetchTeamSchedule: async () => [],
  extractStat: (game, stat) => Number(game.stats[stat] ?? null),
  project: async () => ({ available: false, reason: "n/a" }),
};

describe("runSport", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "edgeboard-runsport-"));
  });

  it("fetches, extracts, fits calibration, deploys", async () => {
    const result = await runSport(mockAdapter, { rootDir: root, minBucketSize: 100 });
    assert.equal(result.status, "ok");
    assert.equal(result.sport, "MOCK");
    assert.ok(result.sampleSize > 0);
  });

  it("produces calibration with spread predictedPMore (not all 0.5)", async () => {
    const result = await runSport(mockAdapter, { rootDir: root, minBucketSize: 100 });
    assert.equal(result.status, "ok");

    // Read the deployed calibration file
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const cal = JSON.parse(
      await readFile(join(root, "artifacts", "mock", "calibration.json"), "utf8"),
    );
    const bucket = cal.buckets["Points|standard"];
    assert.ok(bucket, "expected Points|standard bucket");
    // x values must span more than just 0.5 — find min and max
    const minX = Math.min(...bucket.x);
    const maxX = Math.max(...bucket.x);
    assert.ok(
      maxX - minX > 0.3,
      `expected spread > 0.3 in calibration x-values, got [${minX}, ${maxX}]`,
    );
  });

  it("produces a held-out test split with evaluation metrics", async () => {
    const result = await runSport(mockAdapter, { rootDir: root, minBucketSize: 100 });
    assert.equal(result.status, "ok");
    const m = result.testMetrics;
    assert.ok(m, "expected testMetrics on result");
    // Chronological 80/20 split: both sides non-empty, summing to sampleSize.
    assert.ok(m.sampleSize > 0, "expected non-empty test set");
    assert.ok(m.bucketsEvaluated > 0, "expected at least one evaluated bucket");
    // Probabilities are clamped, so log-losses are finite and non-negative.
    assert.ok(Number.isFinite(m.logLoss) && m.logLoss >= 0);
    assert.ok(Number.isFinite(m.baselineLogLoss) && m.baselineLogLoss >= 0);
    assert.ok(m.accuracy >= 0 && m.accuracy <= 1);

    // Persisted metadata carries the split sizes + metrics.
    const { readFile } = await import("node:fs/promises");
    const meta = JSON.parse(
      await readFile(join(root, "artifacts", "mock", "metadata.json"), "utf8"),
    );
    assert.equal(meta.version, "training-v2");
    assert.ok(meta.trainSampleSize > 0);
    assert.ok(meta.testSampleSize > 0);
    assert.equal(meta.trainSampleSize + meta.testSampleSize, meta.sampleSize);
    assert.ok(meta.testMetrics);
  });

  it("returns failed status when an adapter throws", async () => {
    const badAdapter = {
      ...mockAdapter,
      fetchPlayerRoster: async () => {
        throw new Error("ESPN 503");
      },
    };
    const result = await runSport(badAdapter, { rootDir: root, minBucketSize: 100 });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /ESPN 503/);
  });
});
