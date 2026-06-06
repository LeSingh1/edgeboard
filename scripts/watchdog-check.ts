#!/usr/bin/env tsx
/**
 * 30-minute watchdog. A launchd job (com.edgeboard.watchdog, StartInterval
 * 1800s) runs this around the clock to confirm the training system "works"
 * between the nightly retrains. It is cheap, read-only, and notifies only
 * when something is actually wrong.
 *
 * Three independent health signals:
 *
 *   1. STUCK   — a run is in progress (currentRun.json) but its heartbeat
 *                hasn't advanced in STUCK_MINUTES. The nightly job writes a
 *                heartbeat at every phase boundary, so a frozen heartbeat
 *                means the process hung (network stall, deadlock, …).
 *
 *   2. OVERDUE — the last successful training finished more than OVERDUE_HOURS
 *                ago. A daily 3:15am job should refresh this every ~24h; if
 *                it didn't, launchd didn't fire or the run crashed.
 *
 *   3. UNHEALTHY — the most recent nightly model check (meta/modelCheck.json)
 *                reported problem sports. Surfaced again here so a failure at
 *                3am isn't missed if the notification was dismissed.
 *
 * Exit code is 0 when healthy, 1 when any signal trips — so `launchd`'s log
 * and `launchctl print` show a non-zero last-exit for quick diagnosis.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readProgress, isStuck, notify } from "@/lib/training/watchdog";

const ROOT = "data/training";
const META = join(ROOT, "meta");
const ARTIFACTS = join(ROOT, "artifacts");
const STUCK_MINUTES = 45;     // heartbeat older than this during a run = hung
const OVERDUE_HOURS = 26;     // daily job should refresh within a day
const RESTART_COOLDOWN_MIN = 20;  // don't relaunch more than once per this window
const TRAIN_HEAP_MB = 12288;  // --max-old-space-size; matches the manual OOM-safe run

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

/** Is a training process already running? Matches either the legacy full-train
 *  script or the daily train/test cycle, so the watchdog never double-launches
 *  while either is mid-run. */
function trainingRunning(): boolean {
  try {
    const out = execSync("pgrep -f '(train-all|daily-cycle)\\.ts'", { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false; // pgrep exits non-zero when no match
  }
}

/** Count sports whose deployed artifact is the new train/test (v2) schema. */
async function v2Status(): Promise<{ v2: number; total: number }> {
  let v2 = 0, total = 0;
  try {
    const dirs = await readdir(ARTIFACTS, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      total++;
      const meta = await readJson<{ version?: string }>(join(ARTIFACTS, d.name, "metadata.json"));
      if (meta?.version === "training-v2") v2++;
    }
  } catch { /* no artifacts dir yet */ }
  return { v2, total };
}

/**
 * Self-heal: relaunch the retrain detached so it survives this watchdog
 * process exiting (and launchd reaping the job). Guarded by a cooldown file
 * so a flapping run can't spawn a storm of overlapping trainers.
 */
async function maybeRestartTraining(reason: string): Promise<string | null> {
  // Cooldown: skip if we relaunched within RESTART_COOLDOWN_MIN.
  const stateFile = join(META, "watchdogRestart.json");
  const state = await readJson<{ lastAttemptMs: number; attempts: number }>(stateFile);
  const now = Date.now();
  if (state && now - state.lastAttemptMs < RESTART_COOLDOWN_MIN * 60_000) {
    return `restart suppressed (cooldown, last attempt ${Math.round((now - state.lastAttemptMs) / 60_000)}m ago)`;
  }

  const logFd = openSync(join(META, "manual-v2-run.log"), "a");
  // Spawn the daily cycle (not train-all directly) so a catch-up run honors the
  // odd/even train-vs-test mode for the day it fires on.
  const child = spawn("npx", ["tsx", "scripts/daily-cycle.ts"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${TRAIN_HEAP_MB}` },
  });
  child.unref();

  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    stateFile,
    JSON.stringify({ lastAttemptMs: now, attempts: (state?.attempts ?? 0) + 1, reason, pid: child.pid }, null, 2),
  );
  return `RESTARTED training (pid ${child.pid}) — ${reason}`;
}

async function main() {
  const problems: string[] = [];

  // 1. STUCK — in-progress run whose heartbeat has frozen.
  const progress = await readProgress(META);
  if (progress && progress.phase !== "done") {
    const alive = pidAlive(progress.pid);
    if (alive && isStuck(progress, STUCK_MINUTES * 60_000)) {
      const ageMin = Math.round((Date.now() - new Date(progress.lastUpdate).getTime()) / 60_000);
      problems.push(`STUCK: ${progress.sport} frozen at "${progress.phase}" for ${ageMin}m`);
    } else if (!alive) {
      // Heartbeat says a run is active but the process is gone → it died
      // mid-run without writing the "done" phase.
      problems.push(`DIED: run for ${progress.sport} ended at "${progress.phase}" (pid ${progress.pid} gone)`);
    }
  }

  // 2. OVERDUE — newest successful train timestamp is too old.
  const lastTrained = await readJson<Record<string, string>>(join(META, "lastTrainedAt.json"));
  if (!lastTrained || Object.keys(lastTrained).length === 0) {
    problems.push("OVERDUE: no successful training recorded yet");
  } else {
    const newest = Math.max(...Object.values(lastTrained).map((t) => new Date(t).getTime()));
    const ageH = (Date.now() - newest) / 3600_000;
    if (ageH > OVERDUE_HOURS) {
      problems.push(`OVERDUE: last training was ${ageH.toFixed(1)}h ago (> ${OVERDUE_HOURS}h)`);
    }
  }

  // 3. UNHEALTHY — re-surface the nightly model check verdict.
  const check = await readJson<{ okCount: number; total: number; rows: { sport: string; verdict: string }[] }>(
    join(META, "modelCheck.json"),
  );
  if (check && check.okCount < check.total) {
    const bad = check.rows.filter((r) => r.verdict !== "OK").map((r) => `${r.sport}:${r.verdict}`);
    problems.push(`MODELS: ${check.okCount}/${check.total} healthy — ${bad.join(", ")}`);
  }

  // 4. SELF-HEAL — if no trainer is running but the v2 migration is unfinished
  //    (or the last run is overdue), relaunch it detached so the work finishes
  //    overnight without a human. This is what makes the watchdog actively keep
  //    training alive rather than just reporting that it died.
  const running = trainingRunning();
  const { v2, total } = await v2Status();
  const migrationDone = total > 0 && v2 === total;
  const overdueTripped = problems.some((p) => p.startsWith("OVERDUE"));
  let healAction: string | null = null;
  if (!running && (!migrationDone || overdueTripped)) {
    healAction = await maybeRestartTraining(
      !migrationDone ? `v2 migration incomplete (${v2}/${total})` : "training overdue",
    );
  }

  const stamp = new Date().toISOString();
  if (healAction) console.error(`[watchdog ${stamp}] ${healAction}`);

  if (problems.length === 0 && (running || migrationDone)) {
    console.log(`[watchdog ${stamp}] OK — training system healthy (v2 ${v2}/${total}${running ? ", run in progress" : ""})`);
    process.exit(0);
  } else {
    for (const p of problems) console.error(`[watchdog ${stamp}] ${p}`);
    if (problems.length > 0) {
      notify(problems.join(" | ") + (healAction ? ` | ${healAction}` : ""), "EdgeBoard watchdog alert");
    }
    process.exit(problems.length > 0 ? 1 : 0);
  }
}

main();
