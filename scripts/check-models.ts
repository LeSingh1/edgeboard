#!/usr/bin/env tsx
/**
 * Nightly model health check. Runs right after `train-all.ts` (chained in
 * the launchd job) and answers one question: did tonight's retrain actually
 * produce healthy, improved models?
 *
 * For every deployed sport it reads `artifacts/<sport>/metadata.json` and
 * checks four things:
 *   1. freshness  — trainedAt is within the last STALE_HOURS (the job ran).
 *   2. schema     — version is training-v2 (carries a held-out test split).
 *   3. test set   — testMetrics.sampleSize > 0 (something was evaluated).
 *   4. lift       — calibrated logLoss < baseline logLoss (calibration helps).
 *
 * Prints a per-sport table, fires a macOS notification with the verdict, and
 * exits non-zero if any sport is STALE or REGRESSED — so the launchd log
 * (data/training/meta/launchd.log) records a clear failure to grep for.
 *
 * This is intentionally read-only: it never retrains or mutates artifacts.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SportArtifacts } from "@/lib/sports/types";
import { notify } from "@/lib/training/watchdog";

const ROOT = "data/training";
const ARTIFACTS = join(ROOT, "artifacts");
const STALE_HOURS = 26; // a daily 3:15am job should never be older than this

type Verdict = "OK" | "STALE" | "NO_TEST" | "REGRESSED" | "OLD_SCHEMA";

interface Row {
  sport: string;
  verdict: Verdict;
  ageHours: number | null;
  version: string;
  testN: number;
  logLoss: number | null;
  baseline: number | null;
  /** logLoss improvement over baseline (positive = calibration helped). */
  lift: number | null;
}

async function readMeta(sport: string): Promise<SportArtifacts["metadata"] | null> {
  try {
    const txt = await readFile(join(ARTIFACTS, sport, "metadata.json"), "utf8");
    return JSON.parse(txt) as SportArtifacts["metadata"];
  } catch {
    return null;
  }
}

function classify(meta: SportArtifacts["metadata"] | null): Row["verdict"] {
  if (!meta) return "STALE";
  const ageMs = Date.now() - new Date(meta.trainedAt).getTime();
  if (!(ageMs >= 0) || ageMs > STALE_HOURS * 3600_000) return "STALE";
  if (!meta.version?.includes("v2") || !meta.testMetrics) return "OLD_SCHEMA";
  if (meta.testMetrics.sampleSize <= 0) return "NO_TEST";
  if (meta.testMetrics.logLoss > meta.testMetrics.baselineLogLoss + 1e-9) return "REGRESSED";
  return "OK";
}

async function main() {
  let sports: string[] = [];
  try {
    const entries = await readdir(ARTIFACTS, { withFileTypes: true });
    sports = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    console.error(`check-models: no artifacts dir at ${ARTIFACTS}`);
    notify("No artifacts dir — did training run?", "Model check failed");
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const sport of sports) {
    const meta = await readMeta(sport);
    const verdict = classify(meta);
    const tm = meta?.testMetrics;
    rows.push({
      sport,
      verdict,
      ageHours: meta ? (Date.now() - new Date(meta.trainedAt).getTime()) / 3600_000 : null,
      version: meta?.version ?? "—",
      testN: tm?.sampleSize ?? 0,
      logLoss: tm?.logLoss ?? null,
      baseline: tm?.baselineLogLoss ?? null,
      lift: tm ? tm.baselineLogLoss - tm.logLoss : null,
    });
  }

  const fmt = (n: number | null, d = 4) => (n == null ? "—" : n.toFixed(d));
  console.log("\nNightly model check — " + new Date().toISOString());
  console.log("sport       verdict     age(h)  testN     logLoss  baseline    lift");
  console.log("─".repeat(76));
  for (const r of rows) {
    console.log(
      r.sport.padEnd(11) +
        " " + r.verdict.padEnd(11) +
        " " + (r.ageHours == null ? "  —  " : r.ageHours.toFixed(1)).padStart(6) +
        " " + String(r.testN).padStart(8) +
        " " + fmt(r.logLoss).padStart(9) +
        " " + fmt(r.baseline).padStart(9) +
        " " + (r.lift == null ? "—" : (r.lift >= 0 ? "+" : "") + r.lift.toFixed(4)).padStart(8),
    );
  }

  // Anything not OK is a problem worth a non-zero exit: STALE (job didn't
  // run), OLD_SCHEMA (ran but on pre-v2 code → no test split), NO_TEST
  // (empty held-out set), REGRESSED (calibration lost to baseline).
  const bad = rows.filter((r) => r.verdict !== "OK");
  const okCount = rows.length - bad.length;

  // Persist a machine-readable report next to the other meta files.
  await writeFile(
    join(ROOT, "meta", "modelCheck.json"),
    JSON.stringify({ checkedAt: new Date().toISOString(), okCount, total: rows.length, rows }, null, 2),
  );

  if (bad.length === 0) {
    notify(`${okCount}/${rows.length} sports healthy`, "Nightly model check passed");
    console.log(`\n✔ all good — ${okCount}/${rows.length} healthy`);
    process.exit(0);
  } else {
    const names = bad.map((b) => `${b.sport}:${b.verdict}`).join(", ");
    notify(`Problems: ${names}`, "Nightly model check FAILED");
    console.error(`\n✖ ${bad.length} problem(s): ${names}`);
    process.exit(1);
  }
}

main();
