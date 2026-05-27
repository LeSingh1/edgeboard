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
 * The synthesized picks here are deliberately minimal — `predictedPMore`
 * defaults to 0.5 because the per-game baseline is informationless until
 * the full backtest scorer runs. `fitSportCalibration` only reads
 * `stat`, `oddsType`, `predictedPMore`, and `hit`, but `ScoredPick`'s
 * other fields are typed as required, so we stub them with sane values.
 */

import { join } from "node:path";
import type { SportAdapter, RawGame, SportArtifacts } from "@/lib/sports/types";
import type { ScoredPick } from "@/lib/backtest/aggregate";
import type { ScoreOutput } from "@/lib/backtest/scoreModel";
import { fitSportCalibration } from "./fitSportCalibration";
import { deploySportArtifacts } from "./deployArtifacts";
import { writeProgress } from "./watchdog";

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
    for (const { games } of gamelogs) {
      for (const stat of adapter.supportedStats) {
        const values: number[] = [];
        for (const g of games) {
          const v = adapter.extractStat(g, stat);
          if (v != null && Number.isFinite(v)) values.push(v);
        }
        if (values.length < 5) continue;
        // Synthesize a pick per game: line = season mean rounded to half-step,
        // hit = whether the game's actual value exceeded that line. The raw
        // predictedPMore is fixed at 0.5 — calibration's job is to learn the
        // empirical hit rate of that prior; a future task will swap in real
        // per-game model probabilities from `scoreModel`.
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const line = Math.round(mean * 2) / 2;
        for (const v of values) {
          // Other ScoredPick fields are required by the type but unread by
          // the calibration fitter. Stub them with values that round-trip
          // cleanly through aggregate.ts in case some other downstream
          // consumer ever reuses these.
          const stubScore: ScoreOutput = {
            pMore: 0.5,
            pLess: 0.5,
            baselineProjection: mean,
            projection: mean,
            sigma: 1,
            sampleSize: values.length,
          };
          scoredPicks.push({
            stat,
            oddsType: "standard",
            side: "more",
            predictedPMore: 0.5,
            hit: v > line,
            line,
            actualValue: v,
            score: stubScore,
          });
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
