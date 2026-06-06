#!/usr/bin/env tsx
/**
 * Daily training cycle — alternates by calendar day-of-month.
 *
 *   EVEN day (2, 4, 6, …) → TRAIN
 *     Fold today's finished games into the training set and refit every sport
 *     model (full runPipeline). Each sport still holds out its own ~20% test
 *     split and reports out-of-sample metrics, so "make picks on data you
 *     didn't train on and score them" happens inside every train run too.
 *
 *   ODD day (1, 3, 5, …) → TEST + LEARN
 *     Do NOT fold today into the base models — leave them exactly as the last
 *     even-day run produced them, so today's games are genuinely unseen. Then:
 *       1. walk-forward backtest (scripts/backtest.ts): predict recent games
 *          using only prior data, grade against the real results — "make the
 *          picks as if today never happened, then see your outcome."
 *       2. blend graded real slip outcomes into the live calibration
 *          (scripts/train-from-outcomes.ts) — "learn from how you actually did."
 *     We bump lastTrainedAt afterward so the freshness watchdog stays passive
 *     on a test day (the models were just validated + recalibrated, not stale).
 *
 * A launchd job (com.edgeboard.train) runs this once a day. It takes the SAME
 * train.lock as train-all.ts, so it never overlaps the watchdog's self-heal or
 * a manual run — whichever starts second sees the live lock and exits cleanly.
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

  // Day-of-month parity decides the mode. `getDate()` is local time (the
  // launchd job runs in the user's timezone), matching "even number days".
  // An explicit `train`/`test` argv overrides parity (handy for testing).
  const override = process.argv.slice(2).find((a) => a === "train" || a === "test") as
    | "train"
    | "test"
    | undefined;
  const day = new Date().getDate();
  const mode: "train" | "test" = override ?? (day % 2 === 0 ? "train" : "test");
  const startedAt = new Date().toISOString();
  console.log(`[daily-cycle] ${startedAt} · day-of-month ${day} → ${mode.toUpperCase()} day`);

  let summary: unknown;
  if (mode === "train") {
    // EVEN — fold today's games in and retrain everything.
    summary = await runPipeline({ rootDir: ROOT, minBucketSize: 500, maxConcurrent: 2 });
  } else {
    // ODD — keep base models as-of the last even day (today unseen), then
    // evaluate out-of-sample and learn from graded real outcomes.
    const backtestOk = runScript("walk-forward backtest (out-of-sample eval)", "scripts/backtest.ts");
    const learnOk = runScript("blend graded real outcomes into calibration", "scripts/train-from-outcomes.ts");
    bumpLastTrainedAt();
    summary = {
      mode: "test",
      backtestOk,
      learnOk,
      note: "out-of-sample eval + outcome learning; base models left unchanged so today's games stay held out",
    };
  }

  const finishedAt = new Date().toISOString();
  writeFileSync(CYCLE_LOG, JSON.stringify({ date: startedAt, day, mode, finishedAt, summary }, null, 2));
  console.log(`[daily-cycle] ${mode.toUpperCase()} day complete (${startedAt} → ${finishedAt}).`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
