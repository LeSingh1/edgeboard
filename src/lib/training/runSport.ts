/**
 * Per-sport training job runner. Drives one adapter through the full
 * training pipeline: roster → gamelog fetch → stat extraction → synthetic
 * pick generation → calibration fit → artifact deploy.
 *
 * Writes a heartbeat to `<rootDir>/meta/currentRun.json` at each phase
 * boundary so the watchdog / status surface can tell where the job is.
 *
 * Failure is non-throwing: any error inside the pipeline is caught and
 * returned as `{ status: "failed", error }`. This lets the orchestrator
 * (e.g. cron driver) run every sport without one bad adapter killing
 * the whole batch.
 *
 * Synthesized picks use walk-forward + line-grid sampling: for each
 * player+stat we sort games chronologically, then for each game (after
 * a 5-game warm-up) we compute rolling mean/std from prior games and
 * generate ~7 candidate lines around the mean. Each candidate produces
 * a `predictedPMore` from the normal CDF and a `hit` against the actual
 * value. This gives the calibrator real input variance to fit against —
 * the previous degenerate `predictedPMore = 0.5` produced a no-op
 * calibration table.
 *
 * `fitSportCalibration` only reads `stat`, `oddsType`, `predictedPMore`,
 * and `hit`, but `ScoredPick`'s other fields are typed as required, so
 * we stub them with sane values.
 */

import { join } from "node:path";
import type { SportAdapter, RawGame, SportArtifacts, CalibrationTable, TestMetrics } from "@/lib/sports/types";
import type { ScoredPick } from "@/lib/backtest/aggregate";
import type { ScoreOutput } from "@/lib/backtest/scoreModel";
import { fitSportCalibration } from "./fitSportCalibration";
import { applyCalibrationModel, type CalibrationModel } from "@/lib/backtest/fitCalibration";
import { deploySportArtifacts } from "./deployArtifacts";
import { writeProgress } from "./watchdog";

/** Abramowitz-Stegun approximation of normal CDF. Mirrors the helper in
 *  `src/lib/realProjections.ts` — copied privately to avoid a circular
 *  import surface between training and runtime projection code. */
function cdfNormal(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

export interface RunSportResult {
  sport: string;
  status: "ok" | "failed";
  sampleSize: number;
  durationMs: number;
  error?: string;
  /** Held-out test metrics, when a test split was produced. */
  testMetrics?: TestMetrics;
}

/**
 * Evaluate a fitted calibration table against a held-out test set.
 *
 * The calibration table stores each bucket as parallel `x`/`y` arrays
 * (isotonic breakpoints). We reconstruct a `CalibrationModel` per bucket,
 * route each test pick by its `${stat}|${oddsType}` key, and score the
 * calibrated probability against the actual `hit`.
 *
 * Reports two log-losses so the artifact records whether calibration
 * actually helped: `logLoss` uses the calibrated probability,
 * `baselineLogLoss` uses the raw `predictedPMore`. If calibration is
 * working, `logLoss < baselineLogLoss`.
 *
 * Picks whose bucket has no fitted curve (dropped below minBucketSize)
 * are skipped — they have no calibrated counterpart to evaluate.
 */
function evaluateTestSet(
  testPicks: ScoredPick[],
  table: CalibrationTable,
): TestMetrics {
  const EPS = 1e-6;
  const clampP = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
  // Reconstruct a CalibrationModel per bucket key from the x/y arrays.
  const models = new Map<string, CalibrationModel>();
  for (const [key, b] of Object.entries(table.buckets)) {
    models.set(key, {
      fittedAt: "",
      trainingSize: b.sampleSize,
      breakpoints: b.x.map((xi, i) => ({ predicted: xi, corrected: b.y[i] })),
    });
  }

  let n = 0;
  let logLoss = 0;
  let baselineLogLoss = 0;
  let brier = 0;
  let correct = 0;
  const bucketsSeen = new Set<string>();

  for (const p of testPicks) {
    const key = `${p.stat}|${p.oddsType}`;
    const model = models.get(key);
    if (!model) continue; // no calibrated curve for this bucket
    bucketsSeen.add(key);
    const y = p.hit ? 1 : 0;
    const calibrated = clampP(applyCalibrationModel(model, p.predictedPMore));
    const raw = clampP(p.predictedPMore);
    logLoss += -(y * Math.log(calibrated) + (1 - y) * Math.log(1 - calibrated));
    baselineLogLoss += -(y * Math.log(raw) + (1 - y) * Math.log(1 - raw));
    brier += (calibrated - y) ** 2;
    if ((calibrated >= 0.5 ? 1 : 0) === y) correct++;
    n++;
  }

  return {
    sampleSize: n,
    bucketsEvaluated: bucketsSeen.size,
    logLoss: n > 0 ? logLoss / n : 0,
    baselineLogLoss: n > 0 ? baselineLogLoss / n : 0,
    brier: n > 0 ? brier / n : 0,
    accuracy: n > 0 ? correct / n : 0,
  };
}

interface RunSportOpts {
  /** Training data root. Heartbeat goes under `<rootDir>/meta/`, artifacts
   *  go under `<rootDir>/artifacts/<sport>/`. */
  rootDir: string;
  /** Calibration sample-size floor — passed through to `fitSportCalibration`. */
  minBucketSize: number;
}

export async function runSport(
  adapter: SportAdapter,
  opts: RunSportOpts,
): Promise<RunSportResult> {
  const t0 = Date.now();
  const sportKey = adapter.leagues[0].toLowerCase();
  const metaDir = join(opts.rootDir, "meta");
  const artifactsDir = join(opts.rootDir, "artifacts");

  const checkpoint = (phase: string, pct: number) =>
    writeProgress(metaDir, {
      sport: sportKey,
      phase,
      progressPct: pct,
      lastUpdate: new Date().toISOString(),
      pid: process.pid,
    }).catch(() => undefined);

  try {
    await checkpoint("roster", 0.05);
    const roster = await adapter.fetchPlayerRoster();
    await checkpoint("fetch", 0.15);

    const seasons = adapter.trainingSeasons();
    const gamelogs: { playerId: string; games: RawGame[] }[] = [];
    let done = 0;
    for (const player of roster) {
      const games = await adapter.fetchPlayerGamelog(player.id, seasons);
      gamelogs.push({ playerId: player.id, games });
      done++;
      if (done % 25 === 0) {
        await checkpoint("fetch", 0.15 + 0.55 * (done / roster.length));
      }
    }

    await checkpoint("score", 0.75);
    // Chronological train/test split. Per player+stat, the earliest 80% of
    // walk-forward games feed `trainPicks` (used to fit calibration) and the
    // most recent 20% feed `testPicks` (held out for honest evaluation).
    // Splitting per-player keeps each player represented in both sets and
    // mirrors deployment: we always predict the future from the past.
    const trainPicks: ScoredPick[] = [];
    const testPicks: ScoredPick[] = [];
    const TEST_FRACTION = 0.2;
    // Lower warm-up admits more games into training (helps short-history
    // players and short-season sports), at the cost of noisier early rolling
    // stats — acceptable since the calibrator handles miscalibration.
    const WARMUP = 3;

    // Skip retired / inactive players to save time and keep the model focused
    // on players who actually have betting markets. A player is "active" if
    // their most recent game is within this window. ESPN rosters are already
    // built from current+prior season, but cached sports (soccer/afl/pga/
    // tennis/npb/lol) accumulate a decade of players — this trims the long-
    // retired ones whose stale lines no longer reflect a live player.
    const ACTIVE_WINDOW_MS = 1000 * 60 * 60 * 24 * 730; // ~24 months
    const activeCutoff = Date.now() - ACTIVE_WINDOW_MS;

    // Pass 1 — build the chronological value series for every active player+stat
    // and count "predictable rows" (games eligible for a walk-forward pick).
    // Storing raw numbers here is cheap; the heavy pick objects come in pass 2,
    // after we've sized the line grid against this count. Sizing first is what
    // keeps memory bounded — without it, big-roster sports (NBA/MLB) generate
    // 100M+ picks and blow the heap.
    const series: { stat: string; values: number[] }[] = [];
    let predictableRows = 0;
    for (const { games } of gamelogs) {
      if (games.length === 0) continue;
      // Drop players with no recent game (retired / no longer playing).
      const latestMs = games.reduce((max, g) => {
        const t = Date.parse(g.gameDate);
        return Number.isFinite(t) && t > max ? t : max;
      }, 0);
      // latestMs === 0 means no parseable dates — keep the player (can't tell).
      if (latestMs > 0 && latestMs < activeCutoff) continue;

      // Sort chronologically so rolling stats use only past info.
      const sortedGames = [...games].sort((a, b) =>
        a.gameDate < b.gameDate ? -1 : a.gameDate > b.gameDate ? 1 : 0,
      );
      for (const stat of adapter.supportedStats) {
        // Build the value sequence in game order, dropping games where
        // extractStat returns null/NaN — index alignment is by surviving
        // entries, not original game index (the rolling window only
        // sees games where the stat is defined).
        const values: number[] = [];
        for (const g of sortedGames) {
          const v = adapter.extractStat(g, stat);
          if (v != null && Number.isFinite(v)) values.push(v);
        }
        if (values.length < WARMUP + 1) continue;
        series.push({ stat, values });
        predictableRows += values.length - WARMUP;
      }
    }

    // Adaptive line-grid density. Each predictable row emits one pick per
    // sigma-offset, so total picks ≈ predictableRows × offsetCount. We size the
    // grid so every sport lands above the 10M floor yet under a memory-safe
    // ceiling: data-sparse sports get the densest grid (MAX_OFFSETS spanning
    // -3σ..+3σ), while huge-roster sports get a sparser grid. A hard PICK_CAP
    // (enforced in pass 2) backstops the very largest sports — they stop once
    // they've emitted enough picks, which is still well over 10M. MIN_OFFSETS
    // preserves enough probability spread for a meaningful isotonic fit.
    const PICK_CAP = 16_000_000;   // resident picks per sport — the memory bound
    const MAX_OFFSETS = 31;        // dense grid, 0.2σ steps across [-3σ, +3σ]
    const MIN_OFFSETS = 11;        // floor keeps the calibration curve well-spread
    const offsetCount = Math.max(
      MIN_OFFSETS,
      Math.min(MAX_OFFSETS, predictableRows > 0 ? Math.floor(PICK_CAP / predictableRows) : MAX_OFFSETS),
    );
    const SIGMA_OFFSETS: number[] = [];
    const offsetStep = 6 / (offsetCount - 1);
    for (let j = 0; j < offsetCount; j++) {
      SIGMA_OFFSETS.push(Math.round((-3 + j * offsetStep) * 100) / 100);
    }

    // Shared stub score. Calibration fit and test evaluation only read
    // `stat`/`oddsType`/`predictedPMore`/`hit`, so the `score` object's contents
    // are never used downstream. Pointing every pick at one frozen instance
    // (instead of allocating a fresh object per pick) removes tens of millions
    // of allocations — the single biggest heap saving for large sports.
    const sharedStubScore: ScoreOutput = {
      pMore: 0.5, pLess: 0.5, baselineProjection: 0, projection: 0, sigma: 1, sampleSize: 0,
    };

    // Pass 2 — walk-forward pick generation, bounded by PICK_CAP.
    let capped = false;
    for (const { stat, values } of series) {
      if (capped) break;
      // Index that divides train (earlier games) from test (latest games).
      // cutoff counts from WARMUP since that's the first predictable game.
      const cutoff =
        WARMUP + Math.floor((values.length - WARMUP) * (1 - TEST_FRACTION));

      // Walk-forward: for each game i ≥ WARMUP, compute rolling mean/std
      // from [0..i-1] (strictly past), then sample a grid of candidate
      // lines around that mean. Each candidate becomes one pick.
      for (let i = WARMUP; i < values.length; i++) {
        const past = values.slice(0, i);
        const mu = past.reduce((a, b) => a + b, 0) / past.length;
        const variance =
          past.reduce((a, b) => a + (b - mu) ** 2, 0) / past.length;
        const rawSigma = Math.sqrt(variance);
        // Floor sigma so we don't divide by zero on tight stats (e.g.
        // a player who scored exactly 10 every game) and so the
        // candidate grid stays meaningfully spread.
        const sigma = Math.max(rawSigma, Math.abs(mu) * 0.1, 0.5);
        const actualValue = values[i];
        const bucket = i < cutoff ? trainPicks : testPicks;

        for (const k of SIGMA_OFFSETS) {
          const rawLine = mu + k * sigma;
          const line = Math.round(rawLine * 2) / 2;
          const z = (line - mu) / sigma;
          // pMore = P(value > line) under N(mu, sigma).
          const pMoreRaw = 1 - cdfNormal(z);
          const pMore = Math.min(0.95, Math.max(0.05, pMoreRaw));

          bucket.push({
            stat,
            oddsType: "standard",
            side: "more",
            predictedPMore: pMore,
            hit: actualValue > line,
            line,
            actualValue,
            score: sharedStubScore,
          });
        }
      }
      if (trainPicks.length + testPicks.length >= PICK_CAP) capped = true;
    }

    const totalPicks = trainPicks.length + testPicks.length;
    if (trainPicks.length === 0) {
      return {
        sport: adapter.leagues[0],
        status: "failed",
        sampleSize: 0,
        durationMs: Date.now() - t0,
        error: "Zero training samples — data source may be unavailable",
      };
    }

    await checkpoint("calibrate", 0.85);
    // Fit calibration on the training split only — the test split must stay
    // unseen for its metrics to mean anything.
    const calibration = fitSportCalibration(trainPicks, {
      minBucketSize: opts.minBucketSize,
    });

    // Evaluate the held-out test split against the fitted curves.
    const testMetrics = evaluateTestSet(testPicks, calibration);

    await checkpoint("deploy", 0.95);
    const artifacts: SportArtifacts = {
      calibration,
      defenseRatings: null,
      breakoutProfiles: null,
      gameScriptProfile: null,
      metadata: {
        trainedAt: new Date().toISOString(),
        sampleSize: totalPicks,
        version: "training-v2",
        trainSampleSize: trainPicks.length,
        testSampleSize: testPicks.length,
        testMetrics,
      },
    };
    await deploySportArtifacts({
      sport: sportKey,
      rootDir: artifactsDir,
      artifacts,
    });

    await checkpoint("done", 1.0);
    return {
      sport: adapter.leagues[0],
      status: "ok",
      sampleSize: totalPicks,
      durationMs: Date.now() - t0,
      testMetrics,
    };
  } catch (e) {
    return {
      sport: adapter.leagues[0],
      status: "failed",
      sampleSize: 0,
      durationMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
