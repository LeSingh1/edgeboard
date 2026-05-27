import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploySportArtifacts } from "./deployArtifacts";

describe("deploySportArtifacts", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "edgeboard-deploy-")); });

  it("writes each artifact and replaces an existing live dir atomically", async () => {
    // Start with a stale live dir
    await mkdir(join(root, "nba"), { recursive: true });
    await writeFile(join(root, "nba", "old.json"), "stale");

    await deploySportArtifacts({
      sport: "nba",
      rootDir: root,
      artifacts: {
        calibration: { buckets: { "Points|standard": { x: [0.5], y: [0.52], sampleSize: 1000 } } },
        defenseRatings: null,
        breakoutProfiles: null,
        gameScriptProfile: null,
        metadata: { trainedAt: "2026-05-27T03:15:00Z", sampleSize: 5000, version: "v1" },
      },
    });

    // Old file is gone (whole dir replaced)
    await assert.rejects(() => stat(join(root, "nba", "old.json")));
    // New files present
    const cal = JSON.parse(await readFile(join(root, "nba", "calibration.json"), "utf8"));
    assert.equal(cal.buckets["Points|standard"].sampleSize, 1000);
    const meta = JSON.parse(await readFile(join(root, "nba", "metadata.json"), "utf8"));
    assert.equal(meta.sampleSize, 5000);
  });

  it("skips writing null artifacts", async () => {
    await deploySportArtifacts({
      sport: "tennis",
      rootDir: root,
      artifacts: {
        calibration: { buckets: {} },
        defenseRatings: null,
        breakoutProfiles: null,
        gameScriptProfile: null,
        metadata: { trainedAt: "t", sampleSize: 0, version: "v1" },
      },
    });
    await assert.rejects(() => stat(join(root, "tennis", "defenseRatings.json")));
    await stat(join(root, "tennis", "calibration.json")); // exists
    await stat(join(root, "tennis", "metadata.json"));    // exists
  });
});
