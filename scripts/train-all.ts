#!/usr/bin/env tsx
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "@/lib/training/pipeline";
import "@/lib/sports/registerAll";  // side-effect: registers every adapter

// Single-run lock. Three entry points can launch this script — the nightly
// launchd job (com.edgeboard.train), the self-healing watchdog, and manual
// runs. Without coordination they overlap, all writing the same heartbeat and
// artifacts dir and clobbering each other (observed: 3 concurrent runs left the
// migration stuck at 1/13 for hours). This PID lock guarantees exactly one run:
// any later starter sees a live lock and exits cleanly.
const LOCK = join("data/training", "meta", "train.lock");

function acquireLock(): boolean {
  mkdirSync(join("data/training", "meta"), { recursive: true });
  if (existsSync(LOCK)) {
    const pid = parseInt(readFileSync(LOCK, "utf8").trim(), 10);
    // Is the owner still alive? process.kill(pid, 0) throws if not.
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); return false; } // alive → can't acquire
      catch { /* stale lock — owner gone, fall through to reclaim */ }
    }
  }
  writeFileSync(LOCK, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    if (existsSync(LOCK) && readFileSync(LOCK, "utf8").trim() === String(process.pid)) {
      unlinkSync(LOCK);
    }
  } catch { /* best effort */ }
}

async function main() {
  if (!acquireLock()) {
    console.error(`[train-all] another run is active (lock ${LOCK}) — exiting.`);
    process.exit(0);
  }
  // Release the lock however we exit.
  process.on("exit", releaseLock);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { releaseLock(); process.exit(1); });
  }

  // Optional sport allow-list from argv, e.g. `tsx scripts/train-all.ts lol npb`
  // (or SPORTS=lol,npb). When omitted, every registered sport is trained.
  const argvSports = process.argv.slice(2).flatMap((s) => s.split(","));
  const envSports = (process.env.SPORTS ?? "").split(",");
  const sports = [...argvSports, ...envSports].map((s) => s.trim()).filter(Boolean);

  const summary = await runPipeline({
    rootDir: "data/training",
    minBucketSize: 500,
    maxConcurrent: 2,
    ...(sports.length ? { sports } : {}),
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failedCount > 0 ? 1 : 0);
}
main();
