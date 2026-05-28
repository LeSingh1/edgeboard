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
import type { SportAdapter, RawGame, SportArtifacts } from "@/lib/sports/types";
import type { ScoredPick } from "@/lib/backtest/aggregate";
import type { ScoreOutput } from "@/lib/backtest/scoreModel";
import { fitSportCalibration } from "./fitSportCalibration";
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
    const scoredPicks: ScoredPick[] = [];
    // Candidate-line offsets in standard deviations around the rolling mean.
    // Spread chosen so predictedPMore lands roughly across [0.05, 0.95].
    const SIGMA_OFFSETS = [-2, -1, -0.5, 0, 0.5, 1, 2];
    const WARMUP = 5;

    for (const { games } of gamelogs) {
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

        // Walk-forward: for each game i ≥ WARMUP, compute rolling mean/std
        // from [0..i-1] (strictly past), then sample a grid of candidate
        // lines around that mean. Each candidate becomes one training pick.
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

          for (const k of SIGMA_OFFSETS) {
            const rawLine = mu + k * sigma;
            const line = Math.round(rawLine * 2) / 2;
            const z = (line - mu) / sigma;
            // pMore = P(value > line) under N(mu, sigma).
            const pMoreRaw = 1 - cdfNormal(z);
            const pMore = Math.min(0.95, Math.max(0.05, pMoreRaw));

            const stubScore: ScoreOutput = {
              pMore,
              pLess: 1 - pMore,
              baselineProjection: mu,
              projection: mu,
              sigma,
              sampleSize: past.length,
            };
            scoredPicks.push({
              stat,
              oddsType: "standard",
              side: "more",
              predictedPMore: pMore,
              hit: actualValue > line,
              line,
              actualValue,
              score: stubScore,
            });
          }
        }
      }
    }

    await checkpoint("calibrate", 0.85);
    const calibration = fitSportCalibration(scoredPicks, {
      minBucketSize: opts.minBucketSize,
    });

    await checkpoint("deploy", 0.95);
    const artifacts: SportArtifacts = {
      calibration,
      defenseRatings: null,
      breakoutProfiles: null,
      gameScriptProfile: null,
      metadata: {
        trainedAt: new Date().toISOString(),
        sampleSize: scoredPicks.length,
        version: "training-v1",
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
      sampleSize: scoredPicks.length,
      durationMs: Date.now() - t0,
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
