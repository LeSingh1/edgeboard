#!/usr/bin/env tsx
/**
 * Daily training cycle — RETRAINS EVERY DAY.
 *
 *   Every day → TRAIN
 *     Fold the latest finished games into the training set and refit every
 *     sport model (full runPipeline). Each sport holds out its own ~20% test
 *     split and only deploys through the champion-challenger gate, so a worse
 *     model never replaces a better one.
 *
 *   ODD days additionally → TEST + LEARN (after training)
 *       1. walk-forward backtest (scripts/backtest.ts): predict recent games
 *          using only prior data, grade against the real results.
 *       2. blend graded real slip outcomes into the live calibration
 *          (scripts/train-from-outcomes.ts).
 *
 * (Until 2026-09 even days trained and odd days only tested, so models could
 * sit a day behind. Now the model is always current through yesterday's games.)
 *
 * Runs once a day from two places, whichever gets there first:
 *   - GitHub Actions (.github/workflows/daily-train.yml) — commits the fresh
 *     artifacts back to the repo, so it works even when the Mac is asleep.
 *   - launchd (com.edgeboard.train) on the Mac, 3:15 AM local.
 * It takes the SAME train.lock as train-all.ts, so it never overlaps the
 * watchdog's self-heal or a manual run.
 *
 * argv: `train` = train only (skip the odd-day eval), `test` = eval only.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runPipeline } from "@/lib/training/pipeline";
import "@/lib/sports/registerAll"; // side-effect: registers every sport adapter

const ROOT = "data/training";
const META = join(ROOT, "meta");
const LOCK = join(META, "train.lock");
const CYCLE_LOG = join(META, "dailyCycle.json");

// ── Single-run lock (shared with train-all.ts) ───────────────────────────────
function acquireLock(): boolean {
  mkdirSync(META, { recursive: true });
  if (existsSync(LOCK)) {
    const pid = parseInt(readFileSync(LOCK, "utf8").trim(), 10);
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); return false; } // owner alive → can't acquire
      catch { /* stale lock — owner gone, reclaim */ }
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

/** Run a sibling script in its own process, inheriting cwd + NODE_OPTIONS.
 *  Never throws — a failed eval/learn step shouldn't abort the cycle. */
function runScript(label: string, script: string): boolean {
  try {
    console.log(`[daily-cycle] ${label} → ${script}`);
    execSync(`npx tsx ${script}`, { stdio: "inherit" });
    return true;
  } catch (e) {
    console.error(`[daily-cycle] ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Touch every sport's lastTrainedAt to now. Used on TEST days, which validate
 *  and recalibrate but don't run the full pipeline — this keeps the freshness
 *  watchdog from treating a test day as an overdue/stale model. */
function bumpLastTrainedAt(): void {
  const path = join(META, "lastTrainedAt.json");
  let cur: Record<string, string> = {};
  try { cur = JSON.parse(readFileSync(path, "utf8")); } catch { /* none yet */ }
  const now = new Date().toISOString();
  for (const k of Object.keys(cur)) cur[k] = now;
  if (Object.keys(cur).length > 0) writeFileSync(path, JSON.stringify(cur, null, 2));
}

async function main(): Promise<void> {
  if (!acquireLock()) {
    console.error(`[daily-cycle] another training run holds ${LOCK} — exiting.`);
    process.exit(0);
  }
  process.on("exit", releaseLock);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { releaseLock(); process.exit(1); });
  }

  // `train` / `test` argv override (handy for testing); default is train every
  // day, plus the out-of-sample eval on odd calendar days.
  const override = process.argv.slice(2).find((a) => a === "train" || a === "test") as
    | "train"
    | "test"
    | undefined;
  const day = new Date().getDate();
  const doTrain = override !== "test";
  const doEval = override === "test" || (override == null && day % 2 === 1);
  const mode = doTrain && doEval ? "train+test" : doTrain ? "train" : "test";
  const startedAt = new Date().toISOString();
  console.log(`[daily-cycle] ${startedAt} · day-of-month ${day} → ${mode.toUpperCase()}`);

  const summary: Record<string, unknown> = { mode };
  if (doTrain) {
    summary.pipeline = await runPipeline({ rootDir: ROOT, minBucketSize: 500, maxConcurrent: 2 });
  }
  if (doEval) {
    summary.backtestOk = runScript("walk-forward backtest (out-of-sample eval)", "scripts/backtest.ts");
    summary.learnOk = runScript("blend graded real outcomes into calibration", "scripts/train-from-outcomes.ts");
    if (!doTrain) bumpLastTrainedAt();
  }

  const finishedAt = new Date().toISOString();
  writeFileSync(CYCLE_LOG, JSON.stringify({ date: startedAt, day, mode, finishedAt, summary }, null, 2));
  console.log(`[daily-cycle] ${mode.toUpperCase()} complete (${startedAt} → ${finishedAt}).`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
