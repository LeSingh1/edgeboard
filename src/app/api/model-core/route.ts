import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

/**
 * Model Core telemetry — one rich payload powering the JARVIS-style /model-core
 * HUD. Aggregates the live training pipeline's own outputs (no fabricated
 * numbers): the nightly model check, each deployed artifact's held-out test
 * metrics, the last-trained timestamps, and the in-flight run heartbeat.
 *
 * Everything here is read straight off disk from data/training, so the HUD
 * reflects exactly what the self-retraining cycle has actually produced.
 */

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface ModelCheck {
  checkedAt: string;
  okCount: number;
  total: number;
  rows: {
    sport: string;
    verdict: string;
    ageHours: number;
    version: string;
    testN: number;
    logLoss: number;
    baseline: number;
    lift: number;
  }[];
}

interface ArtifactMeta {
  trainedAt?: string;
  sampleSize?: number;
  trainSampleSize?: number;
  testSampleSize?: number;
  version?: string;
  testMetrics?: { accuracy?: number; brier?: number; logLoss?: number; baselineLogLoss?: number };
}

interface CurrentRun {
  sport?: string;
  phase?: string;
  progressPct?: number;
  lastUpdate?: string;
  pid?: number;
}

/** Pretty display names for the lowercase sport keys the pipeline uses. */
const DISPLAY: Record<string, string> = {
  afl: "AFL", lol: "LoL", mlb: "MLB", nba: "NBA", ncaaf: "NCAAF", nfl: "NFL",
  nhl: "NHL", npb: "NPB", pga: "PGA", sacb: "SACB", soccer: "SOCCER",
  tennis: "TENNIS", wnba: "WNBA",
};

/** The model's "cognitive traits" — the actual decision layers in the
 *  projection pipeline, surfaced as the HUD's personality readout. */
const TRAITS = [
  { key: "gamelog", name: "Game-Log Memory", blurb: "Builds every projection from real ESPN box scores — mean + spread over each player's last 26-59 games.", icon: "database" },
  { key: "recency", name: "Recency Bias", blurb: "Weights recent form above season averages; a hot or cold streak bends the number.", icon: "flame" },
  { key: "context", name: "Context Awareness", blurb: "Layers playoff / matchup overlays on top of the base projection when the spot calls for it.", icon: "target" },
  { key: "calibration", name: "Calibrated Humility", blurb: "An isotonic corrector rescales raw confidence to the observed hit rate — clamped so it can never overclaim.", icon: "scale" },
  { key: "consistency", name: "Consistency Instinct", blurb: "Favors steady, line-clearing players over boom-or-bust ones when picking the safest edges.", icon: "shield" },
  { key: "pushaverse", name: "Push Aversion", blurb: "Prefers half-point lines that cannot land exactly on the number and void the bet.", icon: "divide" },
];

export async function GET() {
  const root = "data/training";
  const [check, lastTrained, current, runHistory] = await Promise.all([
    readJson<ModelCheck>(join(root, "meta", "modelCheck.json")),
    readJson<Record<string, string>>(join(root, "meta", "lastTrainedAt.json")),
    readJson<CurrentRun>(join(root, "meta", "currentRun.json")),
    readJson<unknown[]>(join(root, "meta", "runHistory.json")),
  ]);

  const rows = check?.rows ?? [];
  const sports = await Promise.all(
    rows.map(async (r) => {
      const meta = await readJson<ArtifactMeta>(join(root, "artifacts", r.sport, "metadata.json"));
      const upper = r.sport.toUpperCase();
      const lastTs = lastTrained?.[upper] ?? lastTrained?.[r.sport] ?? meta?.trainedAt ?? null;
      const accuracy = meta?.testMetrics?.accuracy ?? null;
      const brier = meta?.testMetrics?.brier ?? null;
      const sampleSize = meta?.sampleSize ?? r.testN;
      return {
        key: r.sport,
        name: DISPLAY[r.sport] ?? upper,
        verdict: r.verdict, // OK | STALE | ...
        healthy: r.verdict === "OK",
        ageHours: r.ageHours,
        lastTrained: lastTs,
        version: r.version,
        sampleSize,
        trainSamples: meta?.trainSampleSize ?? 0,
        testN: r.testN,
        accuracy,
        brier,
        logLoss: r.logLoss,
        baseline: r.baseline,
        lift: r.lift, // absolute logloss improvement vs baseline
        liftPct: r.baseline > 0 ? r.lift / r.baseline : 0, // relative improvement
      };
    }),
  );

  // Weighted aggregates (by held-out test sample size) — the honest overall.
  const totalTestN = sports.reduce((s, x) => s + (x.testN || 0), 0) || 1;
  const totalSamples = sports.reduce((s, x) => s + (x.sampleSize || 0), 0);
  const trainSamples = sports.reduce((s, x) => s + (x.trainSamples || 0), 0);
  const wAccuracy =
    sports.reduce((s, x) => s + (x.accuracy ?? 0) * (x.testN || 0), 0) / totalTestN;
  const wLiftPct =
    sports.reduce((s, x) => s + x.liftPct * (x.testN || 0), 0) / totalTestN;
  const healthy = sports.filter((x) => x.healthy).length;

  const newestTrained = sports.reduce<string | null>((acc, x) => {
    if (!x.lastTrained) return acc;
    if (!acc) return x.lastTrained;
    return new Date(x.lastTrained) > new Date(acc) ? x.lastTrained : acc;
  }, null);

  // Daily self-improvement cadence: even calendar day = TRAIN on today's games,
  // odd day = hold out today as a live TEST (the /loop the user set up).
  const day = new Date().getDate();
  const todaysMode = day % 2 === 0 ? "train" : "test";

  // "Learning now" must be HONEST: only true when a real process is alive AND
  // its heartbeat is fresh. A stale currentRun.json (process died or finished
  // but left the file) must never keep the HUD claiming it is training.
  function pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  const heartbeatAgeMs = current?.lastUpdate
    ? Date.now() - new Date(current.lastUpdate).getTime()
    : Infinity;
  const trainingLive =
    !!current?.pid && pidAlive(current.pid) && heartbeatAgeMs < 5 * 60_000;

  return NextResponse.json({
    callsign: "EDGE-CORE",
    generatedAt: new Date().toISOString(),
    online: healthy > 0,
    totals: {
      sports: sports.length,
      healthy,
      totalSamples,
      trainSamples,
      avgAccuracy: wAccuracy,
      avgLiftPct: wLiftPct,
      modelVersion: rows[0]?.version ?? "training-v2",
      checkedAt: check?.checkedAt ?? null,
    },
    live: trainingLive
      ? {
          running: true,
          sport: current!.sport ?? null,
          phase: current!.phase ?? null,
          progressPct: current!.progressPct ?? null,
          lastUpdate: current!.lastUpdate ?? null,
        }
      : { running: false, sport: null, phase: null, progressPct: null, lastUpdate: null },
    memory: {
      newestTrained,
      retrainCadence: "daily",
      todaysMode,
      runHistoryCount: Array.isArray(runHistory) ? runHistory.length : 0,
    },
    sports: sports.sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0)),
    traits: TRAITS,
  });
}
