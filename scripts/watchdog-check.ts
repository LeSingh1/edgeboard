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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readProgress, isStuck, notify } from "@/lib/training/watchdog";

const ROOT = "data/training";
const META = join(ROOT, "meta");
const STUCK_MINUTES = 45;     // heartbeat older than this during a run = hung
const OVERDUE_HOURS = 26;     // daily job should refresh within a day

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
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

  const stamp = new Date().toISOString();
  if (problems.length === 0) {
    console.log(`[watchdog ${stamp}] OK — training system healthy`);
    process.exit(0);
  } else {
    for (const p of problems) console.error(`[watchdog ${stamp}] ${p}`);
    notify(problems.join(" | "), "EdgeBoard watchdog alert");
    process.exit(1);
  }
}

main();
