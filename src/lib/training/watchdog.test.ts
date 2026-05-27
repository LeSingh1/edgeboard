import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProgress, readProgress, isStuck, notify } from "./watchdog";

describe("watchdog", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "edgeboard-wd-")); });

  it("writes and reads back currentRun.json", async () => {
    await writeProgress(root, { sport: "nba", phase: "fetch", progressPct: 0.3, lastUpdate: new Date().toISOString(), pid: 123 });
    const r = await readProgress(root);
    assert.equal(r?.sport, "nba");
    assert.equal(r?.phase, "fetch");
  });

  it("flags stuck jobs older than threshold", () => {
    const old = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    assert.equal(isStuck({ sport: "nba", phase: "fetch", progressPct: 0.3, lastUpdate: old, pid: 123 }, 30 * 60 * 1000), true);
  });

  it("does NOT flag fresh jobs", () => {
    assert.equal(isStuck({ sport: "nba", phase: "fetch", progressPct: 0.3, lastUpdate: new Date().toISOString(), pid: 123 }, 30 * 60 * 1000), false);
  });

  it("notify is a function", () => {
    assert.equal(typeof notify, "function");
  });
});
