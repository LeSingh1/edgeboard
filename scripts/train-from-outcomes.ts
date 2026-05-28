/**
 * train-from-outcomes.ts
 *
 * Merges real autopilot slip results from `data/real-outcomes/outcomes.json`
 * into the per-sport calibration artifacts. Each real pick outcome is treated
 * as additional ground-truth for the PAVA isotonic calibration fitter —
 * weighted 10× relative to synthetic samples so real data pulls the curve.
 *
 * Usage:
 *   npx tsx scripts/train-from-outcomes.ts
 *
 * The script re-fits calibration only for the sports that appear in the
 * outcomes log, leaving all other artifacts untouched. Safe to run anytime.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fitSportCalibration } from "../src/lib/training/fitSportCalibration";
import type { ScoredPick } from "../src/lib/backtest/aggregate";
import type { ScoreOutput } from "../src/lib/backtest/scoreModel";

const ROOT = join(import.meta.dirname, "..");
const OUTCOMES_PATH = join(ROOT, "data/real-outcomes/outcomes.json");
const ARTIFACTS_DIR = join(ROOT, "data/training/artifacts");

/** Real weight multiplier — each real pick counts this many times in the
 *  calibration fit. Higher → real data dominates synthetic more quickly.
 *  10 is conservative: 10 real picks ≈ 100 synthetic. Raise to 20-50 as
 *  the outcome log grows and you trust the real signal more. */
const REAL_WEIGHT = 10;

interface RealPick {
  playerName: string;
  sport: string;
  stat: string;
  oddsType: "standard" | "goblin" | "demon";
  side: "more" | "less";
  line: number;
  predictedPMore: number;
  hit: boolean;
}

interface OutcomeEntry {
  date: string;
  slipId: string;
  result: "won" | "lost" | "partial";
  picks: RealPick[];
}

function loadOutcomes(): OutcomeEntry[] {
  if (!existsSync(OUTCOMES_PATH)) {
    console.error(`No outcomes file found at ${OUTCOMES_PATH}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(OUTCOMES_PATH, "utf8")) as OutcomeEntry[];
}

/** Normalize sport names to the artifact directory name used by the training
 *  pipeline. Segment sports (WNBA2H, NBA1Q, etc.) map to their base sport. */
function sportToArtifactKey(sport: string): string {
  const s = sport.toUpperCase();
  // Strip segment suffixes: WNBA2H → WNBA, NBA1Q → NBA, etc.
  const stripped = s.replace(/\d[HQ]$/, "").replace(/\d[HQ]\d$/, "");
  return stripped.toLowerCase();
}

function stubScore(): ScoreOutput {
  return {
    pMore: 0.5,
    pLess: 0.5,
    baselineProjection: 0,
    projection: 0,
    sigma: 1,
    sampleSize: 1,
  };
}

/** Convert real picks to ScoredPick[] with optional weighting (duplication). */
function realPicksToScored(picks: RealPick[], weight: number): ScoredPick[] {
  const out: ScoredPick[] = [];
  for (const p of picks) {
    // The calibration fitter uses predictedPMore as the model confidence
    // and hit as the ground truth. For a LESS pick we flip:
    //   predictedPMore = 1 - predictedPLess
    //   hit = !hitMore
    const predictedPMore = p.side === "more" ? p.predictedPMore : 1 - p.predictedPMore;
    const hit = p.side === "more" ? p.hit : !p.hit;
    const sp: ScoredPick = {
      stat: p.stat,
      oddsType: p.oddsType,
      side: p.side,
      predictedPMore,
      hit,
      line: p.line,
      actualValue: p.hit
        ? (p.side === "more" ? p.line + 0.5 : p.line - 0.5) // estimate: just over/under line
        : (p.side === "more" ? p.line - 0.5 : p.line + 0.5),
      score: stubScore(),
    };
    for (let i = 0; i < weight; i++) out.push(sp);
  }
  return out;
}

async function main() {
  const outcomes = loadOutcomes();
  console.log(`Loaded ${outcomes.length} slip entries from outcomes log.`);

  // Group real picks by artifact sport key
  const bySport = new Map<string, ScoredPick[]>();
  for (const entry of outcomes) {
    for (const pick of entry.picks) {
      const key = sportToArtifactKey(pick.sport);
      const scored = realPicksToScored([pick], REAL_WEIGHT);
      const arr = bySport.get(key) ?? [];
      arr.push(...scored);
      bySport.set(key, arr);
    }
  }

  let updated = 0;
  for (const [sportKey, newPicks] of bySport) {
    const calibPath = join(ARTIFACTS_DIR, sportKey, "calibration.json");
    const metaPath = join(ARTIFACTS_DIR, sportKey, "metadata.json");

    if (!existsSync(calibPath)) {
      // No adapter yet for this sport — bootstrap a seed calibration
      // from real picks alone. minBucketSize=1 so even a single pick lands.
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(ARTIFACTS_DIR, sportKey), { recursive: true });
      const seedCalib = fitSportCalibration(newPicks, { minBucketSize: 1 });
      if (Object.keys(seedCalib.buckets).length === 0) {
        console.warn(`  [${sportKey}] Too few real picks to seed calibration — need at least 1 per bucket.`);
        continue;
      }
      writeFileSync(calibPath, JSON.stringify(seedCalib, null, 2));
      writeFileSync(metaPath, JSON.stringify({
        trainedAt: new Date().toISOString(),
        sampleSize: newPicks.length,
        version: "real-outcomes-v1",
        realOutcomeCount: newPicks.length / REAL_WEIGHT,
        lastRealOutcomeAt: new Date().toISOString(),
      }, null, 2));
      console.log(`  [${sportKey}] Seeded new calibration artifact from ${newPicks.length / REAL_WEIGHT} real picks.`);
      updated++;
      continue;
    }

    // Load existing ScoredPick dataset that was used to fit the current table.
    // We don't store the raw picks post-fit, so we reconstruct approximate
    // synthetic picks from the calibration curve breakpoints as background data,
    // then add the real picks on top.
    //
    // Reconstruction: each (x, y) breakpoint in the calibration table represents
    // a cluster of picks. We generate one synthetic pick per breakpoint per
    // stat|oddsType bucket, setting predictedPMore=x and hit=Bernoulli(y).
    // This keeps the existing shape while letting real picks shift the curve.
    const existingTable = JSON.parse(readFileSync(calibPath, "utf8")) as {
      buckets: Record<string, { x: number[]; y: number[] }>;
    };

    const syntheticBackground: ScoredPick[] = [];
    for (const [bucketKey, { x, y }] of Object.entries(existingTable.buckets)) {
      const [stat, oddsType] = bucketKey.split("|") as [string, "standard" | "goblin" | "demon"];
      for (let i = 0; i < x.length; i++) {
        // Represent each breakpoint as 5 synthetic picks: hitRate × 5 hits
        const hits = Math.round((y[i] ?? 0) * 5);
        for (let j = 0; j < 5; j++) {
          syntheticBackground.push({
            stat,
            oddsType,
            side: "more",
            predictedPMore: x[i],
            hit: j < hits,
            line: 0,
            actualValue: 0,
            score: stubScore(),
          });
        }
      }
    }

    const allPicks = [...syntheticBackground, ...newPicks];
    console.log(
      `  [${sportKey}] ${syntheticBackground.length} synthetic background + ${newPicks.length} real picks (${newPicks.length / REAL_WEIGHT} unique at ${REAL_WEIGHT}× weight)`,
    );

    const newCalibration = fitSportCalibration(allPicks, { minBucketSize: 3 });

    const bucketsAdded = Object.keys(newCalibration.buckets).length;
    if (bucketsAdded === 0) {
      console.warn(`  [${sportKey}] Calibration produced 0 buckets — too few samples. Skipping write.`);
      continue;
    }

    writeFileSync(calibPath, JSON.stringify(newCalibration, null, 2));

    // Update metadata
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.lastRealOutcomeAt = new Date().toISOString();
      meta.realOutcomeCount = (meta.realOutcomeCount ?? 0) + newPicks.length / REAL_WEIGHT;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

    console.log(`  [${sportKey}] Updated calibration with ${bucketsAdded} buckets.`);
    updated++;
  }

  console.log(`\nDone. Updated ${updated} sport calibration artifact(s).`);
  console.log("Real outcome picks are permanently mixed into the calibration.");
  console.log("Run train-all.ts tonight to rebuild from scratch + blend outcomes.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
