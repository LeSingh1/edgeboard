#!/usr/bin/env tsx
/**
 * Backtest orchestrator.
 *
 * One-shot script: fetch gamelogs → synthesize lines → score model →
 * aggregate buckets → fit calibration → persist JSON artifacts.
 *
 * Run from project root:
 *   npx tsx scripts/backtest.ts
 *
 * Outputs (gitignored):
 *   data/backtest/gamelogs.json     raw fetch cache (skipped on re-run < 24h)
 *   data/backtest/report.json       calibration table + per-stat / per-odds breakdowns
 *   data/backtest/calibration.json  trained corrector for the live model
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fetchSeasonLogs } from "@/lib/backtest/fetchSeasonLogs";
import { synthesizeAllRows } from "@/lib/backtest/synthesizeLines";
import { scoreModel } from "@/lib/backtest/scoreModel";
import { aggregate, type ScoredPick } from "@/lib/backtest/aggregate";
import { fitCalibration } from "@/lib/backtest/fitCalibration";

const DATA_DIR = path.join(process.cwd(), "data", "backtest");
const REPORT_PATH = path.join(DATA_DIR, "report.json");
const CALIBRATION_PATH = path.join(DATA_DIR, "calibration.json");

async function main() {
  const t0 = Date.now();
  console.log("[backtest] starting");

  // ── 1. Fetch gamelogs ─────────────────────────────────────────
  const force = process.argv.includes("--force");
  const cache = await fetchSeasonLogs({ force });
  console.log(`[backtest] gamelogs: ${cache.players.length} players`);

  // ── 2. Synthesize lines per (player, game, stat) ─────────────
  const rows = synthesizeAllRows(cache.players);
  console.log(`[backtest] synthesized ${rows.length.toLocaleString()} candidate rows`);

  // ── 3. Build a player index for scoreModel lookups ───────────
  const byName = new Map(cache.players.map((p) => [p.name, p]));

  // ── 4. Score every row, three times (one per oddsType) ───────
  const picks: ScoredPick[] = [];
  let scored = 0;
  let skipped = 0;
  const tScoreStart = Date.now();

  const variants: Array<{ key: "standardLine" | "goblinLine" | "demonLine"; oddsType: ScoredPick["oddsType"] }> = [
    { key: "standardLine", oddsType: "standard" },
    { key: "goblinLine", oddsType: "goblin" },
    { key: "demonLine", oddsType: "demon" },
  ];

  for (const row of rows) {
    const player = byName.get(row.player);
    if (!player) {
      skipped++;
      continue;
    }
    for (const v of variants) {
      const line = row[v.key];
      const out = scoreModel({
        player,
        chronoIndex: row.chronoIndex,
        stat: row.stat,
        line,
        oddsType: v.oddsType,
        propOpponent: row.opponent,
        propIsHome: row.atVs === "vs" ? true : row.atVs === "@" ? false : undefined,
        propGameTime: row.date,
      });
      if (!out) {
        skipped++;
        continue;
      }
      // Choose the model's preferred side (the higher prob). Tie → MORE.
      const side: ScoredPick["side"] = out.pMore >= 0.5 ? "more" : "less";
      const predictedPMore = side === "more" ? out.pMore : out.pLess;
      const hit =
        side === "more"
          ? row.actualValue > line
          : row.actualValue < line;
      picks.push({
        side,
        predictedPMore,
        hit,
        oddsType: v.oddsType,
        stat: row.stat,
        score: out,
        line,
        actualValue: row.actualValue,
      });
      scored++;
    }
  }
  console.log(
    `[backtest] scored ${scored.toLocaleString()} picks ` +
      `(${skipped.toLocaleString()} skipped) in ${Date.now() - tScoreStart}ms`,
  );

  // ── 5. Aggregate buckets + per-oddsType / per-stat breakdowns ─
  const report = aggregate(picks);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`[backtest] wrote ${REPORT_PATH}`);

  // ── 6. Fit isotonic calibration on (predicted, hit) pairs ─────
  const pairs = picks.map((p) => ({ predicted: p.predictedPMore, hit: p.hit }));
  const calibration = fitCalibration(pairs);
  await fs.writeFile(CALIBRATION_PATH, JSON.stringify(calibration, null, 2));
  console.log(
    `[backtest] wrote ${CALIBRATION_PATH} ` +
      `(${calibration.breakpoints.length} breakpoints from ${calibration.trainingSize.toLocaleString()} pairs)`,
  );

  // ── 7. Console summary ────────────────────────────────────────
  console.log("");
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Calibration buckets (overall)`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`  range       predicted   actual    residual    n`);
  for (const b of report.buckets) {
    if (b.n === 0) {
      console.log(`  ${b.range}    —           —         —          0`);
      continue;
    }
    const pp = (b.meanPredicted * 100).toFixed(1).padStart(5);
    const ap = (b.actualHitRate * 100).toFixed(1).padStart(5);
    const rp = (b.residual >= 0 ? "+" : "") + (b.residual * 100).toFixed(1);
    const n = String(b.n).padStart(5);
    console.log(`  ${b.range}    ${pp}%      ${ap}%    ${rp.padStart(6)}%    ${n}`);
  }
  console.log("");
  console.log(`  Total picks:    ${report.totalPicks.toLocaleString()}`);
  console.log(`  Mean predicted: ${(report.syntheticPL.meanPredicted * 100).toFixed(2)}%`);
  console.log(`  Actual hit rate: ${(report.syntheticPL.overallHitRate * 100).toFixed(2)}%`);
  console.log(`  Global residual: ${(report.syntheticPL.meanResidual * 100).toFixed(2)}%`);
  console.log(`  Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("");
  console.log(`  Calibration written. Enable it in Settings to apply.`);
}

main().catch((err) => {
  console.error("[backtest] fatal:", err);
  process.exit(1);
});
