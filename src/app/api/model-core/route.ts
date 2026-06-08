import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeClv, type RecordedPick } from "@/lib/clv";

export const dynamic = "force-dynamic";

/**
 * Model Core telemetry - one rich payload powering the JARVIS-style /model-core
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

interface RunHistoryEntry {
  finishedAt?: string;
  okCount?: number;
  failedCount?: number;
  sports?: {
    sport: string;
    status: string;
    decision: "deployed-first" | "improved" | "refreshed" | "held" | null;
    testLogLoss: number | null;
    championLogLoss: number | null;
    accuracy: number | null;
    lift: number | null;
  }[];
}

/** Pretty display names for the lowercase sport keys the pipeline uses. */
const DISPLAY: Record<string, string> = {
  afl: "AFL", lol: "LoL", mlb: "MLB", nba: "NBA", ncaaf: "NCAAF", nfl: "NFL",
  nhl: "NHL", npb: "NPB", pga: "PGA", sacb: "SACB", soccer: "SOCCER",
  tennis: "TENNIS", wnba: "WNBA",
};

/** The model's "cognitive traits" - the actual decision layers in the
 *  projection pipeline, surfaced as the HUD's personality readout. */
const TRAITS = [
  { key: "gamelog", name: "Game-Log Memory", blurb: "Builds every projection from real ESPN box scores, the mean and spread over each player's recent games.", icon: "database" },
  { key: "recency", name: "Recency Bias", blurb: "Weights recent form above season averages; a hot or cold streak bends the number.", icon: "flame" },
  { key: "context", name: "Context Awareness", blurb: "Layers playoff / matchup overlays on top of the base projection when the spot calls for it.", icon: "target" },
  { key: "calibration", name: "Calibrated Humility", blurb: "An isotonic corrector rescales raw confidence to the observed hit rate, clamped so it can never overclaim.", icon: "scale" },
  { key: "consistency", name: "Consistency Instinct", blurb: "Favors steady, line-clearing players over boom-or-bust ones when picking the safest edges.", icon: "shield" },
  { key: "pushaverse", name: "Push Aversion", blurb: "Prefers half-point lines that cannot land exactly on the number and void the bet.", icon: "divide" },
];

/** Where the model's inputs actually come from. */
const DATA_SOURCES = [
  { name: "ESPN game logs", kind: "box scores", detail: "Primary source. Per-player, per-game box scores for every league, going back years. Drives the projection mean and spread." },
  { name: "balldontlie API", kind: "box scores", detail: "NBA and WNBA enrichment. Fills gaps in player game history that ESPN does not expose." },
  { name: "PrizePicks live board", kind: "lines", detail: "The live lines and prop types being priced across every sport, refreshed every few minutes." },
  { name: "Synthesized training rows", kind: "training", detail: "Synthesized (player, line, outcome) rows generated from historical game logs, used to fit and test the calibrators. The live count is the Total Data figure above." },
  { name: "Trained calibrators", kind: "model", detail: "Per-sport isotonic regression artifacts, retrained daily, that correct the raw model's confidence to the observed hit rate." },
];

/** The contextual layers the projection actually applies before it ever reaches
 *  a probability. Each is a real adjustment in src/lib/realProjections.ts. Not
 *  every one fires on every pick: each needs enough data (e.g. vs-opponent needs
 *  2+ past meetings), and the richest context lands on NBA and WNBA where the
 *  game log carries opponents and dates. Other sports get fewer of these. */
const PROJECTION_SIGNALS = [
  { name: "Recent form", detail: "Recent games are weighted above the season average, so a hot or cold streak bends the projection." },
  { name: "Vs this opponent", detail: "The player's average specifically against the team they face, weighted by how many times they have played them. Needs 2+ meetings to fire." },
  { name: "Home / road split", detail: "Separate home and away averages when there are at least 4 of each. Most players are measurably different on the road." },
  { name: "Days of rest", detail: "Back-to-backs are a fatigue penalty and 3+ days off is fresh, compared against the player's own rest history." },
  { name: "Opponent defense", detail: "Adjusts for how well the opposing team limits this stat, from a defense-ratings table (when one is loaded)." },
  { name: "Breakout ceiling", detail: "Accounts for how often the player has spiked well above their average, so a real high ceiling is not flattened away." },
  { name: "Game script", detail: "Expected blowout vs close game. Pace and garbage time change how much a player actually produces." },
  { name: "Playoff context", detail: "A postseason overlay for playoff games, where rotations tighten and stars play more minutes." },
  { name: "Press conference / news", detail: "A soft signal aggregated from team news, ESPN, and Claude-read press conferences (injuries, role changes). It nudges the number, it does not drive it." },
  { name: "Kalshi market", detail: "Cross-checks the projection against the Kalshi prediction-market price when one exists for the event." },
];

/** The actual rules the app uses to choose and grade picks. */
const GRADING_CRITERIA = [
  { name: "Calibrated probability", role: "primary", detail: "The hit probability after isotonic calibration, clamped to a +/-0.20 swing so a sparse bucket can never overclaim." },
  { name: "Recent line-clear rate", role: "primary", detail: "How often the player actually cleared this line in recent games. Steady clearers rank above boom-or-bust players." },
  { name: "Expected value", role: "primary", detail: "Slips are scored on the real PrizePicks flex and power payout tiers. The lowest flex tier cashes but loses money, so it is counted as a loss." },
  { name: "Half-point lines", role: "filter", detail: "Picks on .5 lines are favored. A whole number can land exactly on the line and void the bet (a push)." },
  { name: "Probability floor", role: "filter", detail: "In safe or consistent-only mode, coinflip picks below about 62% are dropped entirely." },
  { name: "Correlation and reversion", role: "adjustment", detail: "Picks from the same game are penalized. They are not independent, and PrizePicks pays same-game slips less." },
  { name: "Pick style", role: "preference", detail: "Green goblins (easier line), standard, or red demons (harder line, bigger payout) can be preferred or excluded." },
  { name: "Quarter Kelly staking", role: "staking", detail: "Stake size is a quarter of the Kelly fraction, because the probability estimate itself has error and full Kelly is too aggressive." },
];

export async function GET() {
  const root = "data/training";
  const [check, lastTrained, current, runHistory, clvLog] = await Promise.all([
    readJson<ModelCheck>(join(root, "meta", "modelCheck.json")),
    readJson<Record<string, string>>(join(root, "meta", "lastTrainedAt.json")),
    readJson<CurrentRun>(join(root, "meta", "currentRun.json")),
    readJson<RunHistoryEntry[]>(join(root, "meta", "runHistory.json")),
    readJson<RecordedPick[]>(join(root, "meta", "clvLog.json")),
  ]);

  // Closing-line value: the real-market validator. Empty until the pick ledger
  // accrues closes, and that empty state is honest, not hidden. A beatRate
  // persistently above 50% is the only trustworthy proof of edge.
  const clv = summarizeClv(Array.isArray(clvLog) ? clvLog : []);

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

  // Weighted aggregates (by held-out test sample size) - the honest overall.
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

  // Daily retrain cadence: even calendar day = TRAIN on today's games,
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

  // Champion-challenger summary from the most recent run. Each daily retrain is
  // scored against the live model on the same held-out games and only promoted
  // if it is not meaningfully worse, so these counts are the honest readout of
  // "did the model get better, stay current, or hold" on the last cycle.
  const history = Array.isArray(runHistory) ? runHistory : [];
  const lastRun = history.length ? history[history.length - 1] : null;
  const lastRunSummary = lastRun
    ? {
        finishedAt: lastRun.finishedAt ?? null,
        improved: (lastRun.sports ?? []).filter((s) => s.decision === "improved").length,
        refreshed: (lastRun.sports ?? []).filter((s) => s.decision === "refreshed").length,
        held: (lastRun.sports ?? []).filter((s) => s.decision === "held").length,
      }
    : null;

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
      runHistoryCount: history.length,
      lastRun: lastRunSummary,
    },
    clv,
    sports: sports.sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0)),
    traits: TRAITS,
    projectionSignals: PROJECTION_SIGNALS,
    dataSources: DATA_SOURCES,
    gradingCriteria: GRADING_CRITERIA,
  });
}
