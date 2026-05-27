import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArtifactsForSport, _resetArtifactCache } from "./artifactCache";

describe("artifactCache", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "edgeboard-art-"));
    _resetArtifactCache();
  });

  it("returns empty artifacts when sport folder is missing", async () => {
    const a = await loadArtifactsForSport("nba", root);
    assert.equal(a.calibration, null);
    assert.equal(a.metadata.sampleSize, 0);
  });

  it("reads calibration.json + metadata.json when present", async () => {
    await mkdir(join(root, "nba"), { recursive: true });
    await writeFile(join(root, "nba", "calibration.json"), JSON.stringify({ buckets: { "Points|standard": { x: [0.5], y: [0.52], sampleSize: 1000 } } }));
    await writeFile(join(root, "nba", "metadata.json"), JSON.stringify({ trainedAt: "2026-05-27T03:15:00Z", sampleSize: 5000, version: "v1" }));
    const a = await loadArtifactsForSport("nba", root);
    assert.equal(a.calibration?.buckets["Points|standard"].sampleSize, 1000);
    assert.equal(a.metadata.sampleSize, 5000);
  });

  it("reloads when mtime changes", async () => {
    await mkdir(join(root, "nba"), { recursive: true });
    await writeFile(join(root, "nba", "metadata.json"), JSON.stringify({ trainedAt: "t1", sampleSize: 1, version: "v1" }));
    const a1 = await loadArtifactsForSport("nba", root);
    assert.equal(a1.metadata.trainedAt, "t1");
    // Overwrite + bump mtime
    await writeFile(join(root, "nba", "metadata.json"), JSON.stringify({ trainedAt: "t2", sampleSize: 2, version: "v1" }));
    const newer = new Date(Date.now() + 5000);
    await utimes(join(root, "nba", "metadata.json"), newer, newer);
    const a2 = await loadArtifactsForSport("nba", root);
    assert.equal(a2.metadata.trainedAt, "t2");
  });
});
