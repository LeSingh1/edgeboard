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
