#!/usr/bin/env tsx
/**
 * Offline tuner for the heuristic projection model.
 *
 * Loads the cached gamelogs, builds the labeled backtest dataset, splits
 * 80/20 train/holdout, then runs coordinate descent over the constants
 * defined in `MODEL_CONSTANTS`. For each constant, sweeps a candidate
 * range while holding the others fixed, picks the value that minimizes
 * log-loss on the training set, keeps it, moves to the next.
 *
 * After tuning, evaluates the final constants on the holdout set and
 * compares to the baseline. If holdout log-loss improves, the new
 * constants are written into `src/lib/modelConstants.ts` (in place).
 * If it doesn't, we keep the baseline.
 *
 * Coordinate descent isn't optimal (misses interactions) but for a
 * dozen constants on ~700K training examples it's deterministic, fast
 * (~5 min wall time), and the comment trail in MODEL_CONSTANTS makes
 * the tuning auditable.
 *
 * Run:  npx tsx scripts/tune-heuristic.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fetchSeasonLogs, type PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";
import { synthesizeAllRows, type BacktestRow } from "@/lib/backtest/synthesizeLines";
import { scoreModel } from "@/lib/backtest/scoreModel";
import { MODEL_CONSTANTS, type ModelConstants } from "@/lib/modelConstants";

interface LabeledExample {
  player: PlayerGamelog;
  chronoIndex: number;
  stat: string;
  line: number;
  oddsType: "standard" | "goblin" | "demon";
  propOpponent?: string;
  propIsHome?: boolean;
  propGameTime?: string;
  actualValue: number;
}

const VARIANTS: Array<{ key: keyof BacktestRow; oddsType: LabeledExample["oddsType"] }> = [
  { key: "standardLine", oddsType: "standard" },
  { key: "goblinLine", oddsType: "goblin" },
  { key: "demonLine", oddsType: "demon" },
];

/** Build the labeled training set from the cached gamelogs. */
function buildDataset(players: PlayerGamelog[]): LabeledExample[] {
  const byName = new Map(players.map((p) => [p.name, p]));
  const rows = synthesizeAllRows(players);
  const out: LabeledExample[] = [];
  for (const row of rows) {
    const player = byName.get(row.player);
    if (!player) continue;
    for (const v of VARIANTS) {
      out.push({
        player,
        chronoIndex: row.chronoIndex,
        stat: row.stat,
        line: row[v.key] as number,
        oddsType: v.oddsType,
        propOpponent: row.opponent,
        propIsHome: row.atVs === "vs" ? true : row.atVs === "@" ? false : undefined,
        propGameTime: row.date,
        actualValue: row.actualValue,
      });
    }
  }
  return out;
}

/** Pick the model's preferred side, evaluate against actual.
 *  Returns the chosen pMore and whether the chosen side hit. */
function scoreOne(ex: LabeledExample, constants: ModelConstants):
  | { p: number; hit: boolean }
  | null {
  const out = scoreModel({
    player: ex.player,
    chronoIndex: ex.chronoIndex,
    stat: ex.stat,
    line: ex.line,
    oddsType: ex.oddsType,
    propOpponent: ex.propOpponent,
    propIsHome: ex.propIsHome,
    propGameTime: ex.propGameTime,
    constants,
  });
  if (!out) return null;
  const moreHit = ex.actualValue > ex.line;
  if (out.pMore >= 0.5) {
    return { p: out.pMore, hit: moreHit };
  } else {
    return { p: out.pLess, hit: !moreHit };
  }
}

/** Mean log-loss across examples. Lower is better. Clamps to avoid log(0). */
function logLoss(examples: LabeledExample[], constants: ModelConstants): number {
  let sum = 0;
  let count = 0;
  for (const ex of examples) {
    const r = scoreOne(ex, constants);
    if (!r) continue;
    const p = Math.max(1e-6, Math.min(1 - 1e-6, r.p));
    sum += r.hit ? -Math.log(p) : -Math.log(1 - p);
    count++;
  }
  return count === 0 ? Infinity : sum / count;
}

/** Calibration gap: mean |predicted - actual hit rate| across 5 buckets.
 *  Secondary metric — log-loss is the primary, but calibration gap is
 *  easier to interpret intuitively. */
function calibrationGap(examples: LabeledExample[], constants: ModelConstants): number {
  const bins = [
    { lo: 0.5, hi: 0.6 },
    { lo: 0.6, hi: 0.7 },
    { lo: 0.7, hi: 0.8 },
    { lo: 0.8, hi: 0.9 },
    { lo: 0.9, hi: 1.01 },
  ];
  let total = 0;
  let count = 0;
  for (const bin of bins) {
    let pSum = 0;
    let hits = 0;
    let n = 0;
    for (const ex of examples) {
      const r = scoreOne(ex, constants);
      if (!r) continue;
      if (r.p < bin.lo || r.p >= bin.hi) continue;
      pSum += r.p;
      if (r.hit) hits++;
      n++;
    }
    if (n < 20) continue;
    const meanPred = pSum / n;
    const actual = hits / n;
    total += Math.abs(meanPred - actual);
    count++;
  }
  return count === 0 ? Infinity : total / count;
}

/** Coordinate descent. Sweeps `candidates` for each parameter while
 *  holding the rest fixed, keeps the best, moves on. One full pass. */
interface ParamSweep {
  name: keyof ModelConstants;
  candidates: number[];
}
const SWEEPS: ParamSweep[] = [
  // Most impactful first — the sigma floor directly compresses pMore
  // toward 0.5, addressing the overall overconfidence we saw.
  { name: "sigmaFloorMultiplier", candidates: [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50] },
  { name: "sigmaFloorAbsolute", candidates: [0.25, 0.50, 0.75, 1.0, 1.5] },

  // Adjustment confidences — how much we trust each signal.
  { name: "recentFormConfidence", candidates: [0.30, 0.40, 0.50, 0.55, 0.65, 0.75] },
  { name: "vsOppConfidenceCap", candidates: [0.30, 0.40, 0.50, 0.60, 0.70] },
  { name: "vsOppConfidencePerGame", candidates: [0.05, 0.08, 0.10, 0.13, 0.15] },
  { name: "homeAwayConfidenceCap", candidates: [0.30, 0.40, 0.50, 0.60] },
  { name: "homeAwayConfidencePerSide", candidates: [0.02, 0.03, 0.04, 0.05, 0.06] },
  { name: "daysRestConfidenceCap", candidates: [0.20, 0.30, 0.40, 0.50] },
  { name: "daysRestConfidencePerGame", candidates: [0.01, 0.02, 0.03, 0.04, 0.05] },

  // Shift thresholds — how much movement is required to fire a signal.
  { name: "recentFormShiftThresholdSigma", candidates: [0.10, 0.15, 0.20, 0.25, 0.30] },
  { name: "vsOppShiftThresholdSigma", candidates: [0.10, 0.15, 0.20, 0.25, 0.30] },
  { name: "homeAwayShiftThresholdSigma", candidates: [0.10, 0.15, 0.20, 0.25, 0.30] },
  { name: "daysRestShiftThresholdSigma", candidates: [0.10, 0.15, 0.20, 0.25, 0.30] },

  // Final clamp — extreme tails are usually wrong. Loosening = more confident.
  { name: "pMoreClampLow", candidates: [0.02, 0.05, 0.10] },
  { name: "pMoreClampHigh", candidates: [0.90, 0.95, 0.98] },
];

function shuffle<T>(arr: T[], seed: number): T[] {
  // Mulberry32 PRNG for deterministic shuffle
  let s = seed;
  const rng = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Write the tuned constants back into src/lib/modelConstants.ts.
 *  We rewrite the whole file from a template since the format is simple. */
async function persistConstants(c: ModelConstants, evalSummary: string): Promise<void> {
  const ts = new Date().toISOString();
  const src = `/**
 * Tunable constants for the heuristic projection model.
 *
 * These were originally hand-picked in \`realProjections.ts\`. Lifting
 * them here lets both the live model and the offline tuning script
 * (\`scripts/tune-heuristic.ts\`) share one source of truth.
 *
 * Values updated by tuning runs are committed back here as code.
 *
 * Last tuned: ${ts}
 * ${evalSummary}
 */

export const MODEL_CONSTANTS = {
  // ── Variance floor ────────────────────────────────────────────────
  sigmaFloorMultiplier: ${c.sigmaFloorMultiplier},
  sigmaFloorAbsolute: ${c.sigmaFloorAbsolute},

  // ── Adjustment: recent form (last-5 vs season) ────────────────────
  recentFormShiftThresholdSigma: ${c.recentFormShiftThresholdSigma},
  recentFormConfidence: ${c.recentFormConfidence},

  // ── Adjustment: vs specific opponent ──────────────────────────────
  vsOppShiftThresholdSigma: ${c.vsOppShiftThresholdSigma},
  vsOppConfidenceBase: ${c.vsOppConfidenceBase},
  vsOppConfidencePerGame: ${c.vsOppConfidencePerGame},
  vsOppConfidenceCap: ${c.vsOppConfidenceCap},

  // ── Adjustment: home / away split ─────────────────────────────────
  homeAwayShiftThresholdSigma: ${c.homeAwayShiftThresholdSigma},
  homeAwayConfidenceBase: ${c.homeAwayConfidenceBase},
  homeAwayConfidencePerSide: ${c.homeAwayConfidencePerSide},
  homeAwayConfidenceCap: ${c.homeAwayConfidenceCap},

  // ── Adjustment: days-rest bucket ──────────────────────────────────
  daysRestShiftThresholdSigma: ${c.daysRestShiftThresholdSigma},
  daysRestConfidenceBase: ${c.daysRestConfidenceBase},
  daysRestConfidencePerGame: ${c.daysRestConfidencePerGame},
  daysRestConfidenceCap: ${c.daysRestConfidenceCap},

  // ── pMore clamp ────────────────────────────────────────────────────
  pMoreClampLow: ${c.pMoreClampLow},
  pMoreClampHigh: ${c.pMoreClampHigh},
} as const;

export type ModelConstants = typeof MODEL_CONSTANTS;
`;
  const dst = path.join(process.cwd(), "src", "lib", "modelConstants.ts");
  await fs.writeFile(dst, src);
  console.log(`[tune] wrote ${dst}`);
}

async function main() {
  const t0 = Date.now();
  console.log("[tune] loading gamelogs (24h cache)…");
  const { players } = await fetchSeasonLogs();
  console.log(`[tune] ${players.length} players`);

  console.log("[tune] building labeled dataset…");
  const all = buildDataset(players);
  console.log(`[tune] ${all.length.toLocaleString()} examples`);

  // 80/20 split, deterministic shuffle
  const shuffled = shuffle(all, 1234);
  const split = Math.floor(shuffled.length * 0.8);
  const train = shuffled.slice(0, split);
  const holdout = shuffled.slice(split);
  console.log(`[tune] train=${train.length.toLocaleString()}  holdout=${holdout.length.toLocaleString()}`);

  // Subsample train if it's enormous — 100K samples is plenty to estimate
  // log-loss reliably and keeps each sweep under ~2s wall time.
  const TRAIN_CAP = 100_000;
  const trainSubset = train.length > TRAIN_CAP ? shuffle(train, 99).slice(0, TRAIN_CAP) : train;
  console.log(`[tune] tuning on ${trainSubset.length.toLocaleString()} samples`);

  // ── Baseline ──────────────────────────────────────────────────
  const baselineConstants = { ...MODEL_CONSTANTS };
  const baselineLossTrain = logLoss(trainSubset, baselineConstants);
  const baselineLossHoldout = logLoss(holdout, baselineConstants);
  const baselineCalibTrain = calibrationGap(trainSubset, baselineConstants);
  const baselineCalibHoldout = calibrationGap(holdout, baselineConstants);
  console.log("");
  console.log(`Baseline log-loss:        train=${baselineLossTrain.toFixed(5)}  holdout=${baselineLossHoldout.toFixed(5)}`);
  console.log(`Baseline calibration gap: train=${(baselineCalibTrain * 100).toFixed(2)}%  holdout=${(baselineCalibHoldout * 100).toFixed(2)}%`);
  console.log("");

  // ── Coordinate descent ────────────────────────────────────────
  const current: ModelConstants = { ...baselineConstants };
  for (const sweep of SWEEPS) {
    const sweepStart = Date.now();
    let bestVal = current[sweep.name] as number;
    let bestLoss = logLoss(trainSubset, current);
    let bestCalib = calibrationGap(trainSubset, current);
    for (const cand of sweep.candidates) {
      if (cand === current[sweep.name]) continue;
      const trial = { ...current, [sweep.name]: cand };
      const l = logLoss(trainSubset, trial);
      if (l < bestLoss) {
        bestLoss = l;
        bestVal = cand;
        bestCalib = calibrationGap(trainSubset, trial);
      }
    }
    const changed = bestVal !== current[sweep.name];
    if (changed) {
      (current[sweep.name] as number) = bestVal;
    }
    const ms = Date.now() - sweepStart;
    console.log(
      `  ${sweep.name.padEnd(32)} ${changed ? "→" : "·"} ${String(bestVal).padStart(6)}   ` +
        `loss=${bestLoss.toFixed(5)}  calib=${(bestCalib * 100).toFixed(2)}%   (${ms}ms)`,
    );
  }

  // ── Evaluate on holdout ───────────────────────────────────────
  const tunedLossHoldout = logLoss(holdout, current);
  const tunedCalibHoldout = calibrationGap(holdout, current);
  console.log("");
  console.log(`Tuned log-loss on holdout:        ${tunedLossHoldout.toFixed(5)}  (Δ ${(tunedLossHoldout - baselineLossHoldout).toFixed(5)})`);
  console.log(`Tuned calibration gap on holdout: ${(tunedCalibHoldout * 100).toFixed(2)}%   (Δ ${((tunedCalibHoldout - baselineCalibHoldout) * 100).toFixed(2)}%)`);

  // ── Decide ────────────────────────────────────────────────────
  const improved = tunedLossHoldout < baselineLossHoldout - 1e-5;
  if (improved) {
    const summary =
      `* Holdout log-loss: ${baselineLossHoldout.toFixed(5)} → ${tunedLossHoldout.toFixed(5)} ` +
      `(Δ ${(tunedLossHoldout - baselineLossHoldout).toFixed(5)})\n * ` +
      `Holdout calibration gap: ${(baselineCalibHoldout * 100).toFixed(2)}% → ${(tunedCalibHoldout * 100).toFixed(2)}% ` +
      `(Δ ${((tunedCalibHoldout - baselineCalibHoldout) * 100).toFixed(2)}%)`;
    await persistConstants(current, summary);
    console.log("");
    console.log("[tune] HOLDOUT IMPROVED — constants persisted to src/lib/modelConstants.ts");
  } else {
    console.log("");
    console.log("[tune] no holdout improvement — baseline constants kept");
  }
  console.log(`[tune] elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("[tune] fatal:", err);
  process.exit(1);
});
