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
import { fitPerStatCalibration } from "@/lib/backtest/fitCalibration";
import { buildDefenseRatings } from "@/lib/backtest/defenseRatings";
import { buildBreakoutProfiles } from "@/lib/backtest/breakoutProfile";
import { buildGameScript } from "@/lib/backtest/gameScriptBuilder";
import { crossValidateCalibration, walkForwardValidate } from "@/lib/backtest/crossValidate";

const DATA_DIR = path.join(process.cwd(), "data", "backtest");
const REPORT_PATH = path.join(DATA_DIR, "report.json");
const CALIBRATION_PATH = path.join(DATA_DIR, "calibration.json");
const DEFENSE_PATH = path.join(DATA_DIR, "defenseRatings.json");
const BREAKOUT_PATH = path.join(DATA_DIR, "breakoutProfiles.json");
const GAME_SCRIPT_PROFILE_PATH = path.join(DATA_DIR, "gameScriptProfile.json");
const TEAM_SCORING_PATH = path.join(DATA_DIR, "teamScoring.json");
const CV_PATH = path.join(DATA_DIR, "crossValidation.json");
const WALKFWD_PATH = path.join(DATA_DIR, "walkForward.json");

async function main() {
  const t0 = Date.now();
  console.log("[backtest] starting");

  // ── 1. Fetch gamelogs ─────────────────────────────────────────
  const force = process.argv.includes("--force");
  const cache = await fetchSeasonLogs({ force });
  console.log(`[backtest] gamelogs: ${cache.players.length} players`);

  // ── 2a. Build per-team defensive ratings from the gamelog corpus ─
  const defense = buildDefenseRatings(cache.players);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DEFENSE_PATH, JSON.stringify(defense, null, 2));
  const teamCount = Object.keys(defense.byTeam).length;
  const statCount = Object.keys(defense.leagueAvg).length;
  console.log(`[backtest] defense ratings: ${teamCount} teams × ${statCount} stats → ${DEFENSE_PATH}`);

  // ── 2a-ii. Per-player breakout-rate profiles ────────────────────
  const breakout = buildBreakoutProfiles(cache.players, defense);
  await fs.writeFile(BREAKOUT_PATH, JSON.stringify(breakout, null, 2));
  const playersWithProfiles = Object.keys(breakout.byPlayer).length;
  console.log(
    `[backtest] breakout profiles: ${playersWithProfiles} players, ` +
      `baseline rates per stat → ${BREAKOUT_PATH}`,
  );

  // ── 2a-iii. Game-script residual profile + team-scoring table ────
  const gs = buildGameScript(cache.players);
  await fs.writeFile(GAME_SCRIPT_PROFILE_PATH, JSON.stringify(gs.profile, null, 2));
  await fs.writeFile(TEAM_SCORING_PATH, JSON.stringify(gs.scoring, null, 2));
  console.log(
    `[backtest] game-script: ${Object.keys(gs.scoring.byTeam).length} teams, ` +
      `${gs.observations.toLocaleString()} player-game residuals ` +
      `(${gs.coverage.bothSides} events both-sides) → ${GAME_SCRIPT_PROFILE_PATH}`,
  );

  // ── 2b. Synthesize lines per (player, game, stat) ────────────────
  const rows = synthesizeAllRows(cache.players);
  console.log(`[backtest] synthesized ${rows.length.toLocaleString()} candidate rows`);

  // ── 3. Build a player index for scoreModel lookups ───────────
  const byName = new Map(cache.players.map((p) => [p.name, p]));

  // ── 4. Score every row, three times (one per oddsType) ───────
  const picks: ScoredPick[] = [];
  const datedPairs: Array<{ predicted: number; hit: boolean; date: string }> = [];
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
        defenseRatings: defense,
        breakoutProfiles: breakout,
        teamScoring: gs.scoring,
        gameScriptProfile: gs.profile,
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
      datedPairs.push({ predicted: predictedPMore, hit, date: row.date });
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

  // ── 6. Fit per-stat × per-oddsType isotonic calibration ──────────
  const pairs = picks.map((p) => ({
    predicted: p.predictedPMore,
    hit: p.hit,
    oddsType: p.oddsType,
    stat: p.stat,
  }));
  const calibration = fitPerStatCalibration(pairs);
  await fs.writeFile(CALIBRATION_PATH, JSON.stringify(calibration, null, 2));
  const statCells = Object.keys(calibration.byStatOdds);
  console.log(
    `[backtest] wrote ${CALIBRATION_PATH} ` +
      `(all: ${calibration.all.breakpoints.length} bp, ` +
      `per-odds: 3 curves, ` +
      `per-stat×odds: ${statCells.length} stats × ≤3 cells from ${calibration.trainingSize.toLocaleString()} pairs)`,
  );
  for (const stat of statCells) {
    const row = calibration.byStatOdds[stat];
    const parts: string[] = [];
    for (const ot of ["standard", "goblin", "demon"] as const) {
      if (row[ot]) parts.push(`${ot}=${row[ot].breakpoints.length}bp/${row[ot].trainingSize.toLocaleString()}`);
    }
    console.log(`    · ${stat.padEnd(20)} ${parts.join("  ")}`);
  }

  // ── 6b. 5-fold CV — measures calibration stability ──────────────
  console.log(`[backtest] running 5-fold cross-validation…`);
  const cvReport = crossValidateCalibration(
    pairs.map((p) => ({ predicted: p.predicted, hit: p.hit })),
    5,
  );
  await fs.writeFile(CV_PATH, JSON.stringify(cvReport, null, 2));
  console.log(
    `[backtest] wrote ${CV_PATH} ` +
      `(5-fold held-out global residual: ${(cvReport.globalMeanResidual * 100).toFixed(2)}% ` +
      `± ${(cvReport.globalStdResidual * 100).toFixed(2)}%)`,
  );

  // ── 6c. Walk-forward validation — temporal drift detector ───────
  console.log(`[backtest] running walk-forward validation by month…`);
  const wfReport = walkForwardValidate(datedPairs);
  await fs.writeFile(WALKFWD_PATH, JSON.stringify(wfReport, null, 2));
  console.log(
    `[backtest] wrote ${WALKFWD_PATH} ` +
      `(${wfReport.months.length} evaluated months; ` +
      `mean |residual| = ${(wfReport.meanAbsResidual * 100).toFixed(2)}%)`,
  );
  for (const m of wfReport.months) {
    const sign = m.residual >= 0 ? "+" : "";
    console.log(
      `    · ${m.month}  train ${m.trainSize.toString().padStart(7)}  ` +
        `eval ${m.evalSize.toString().padStart(6)}  ` +
        `pred ${(m.meanPredicted * 100).toFixed(1)}%  actual ${(m.actualHitRate * 100).toFixed(1)}%  ` +
        `Δ ${sign}${(m.residual * 100).toFixed(2)}%`,
    );
  }

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
  console.log(`  Calibration written. Live model applies it automatically on next request.`);
  console.log(`  To disable: set DISABLE_CALIBRATION=1 in the server env.`);
}

main().catch((err) => {
  console.error("[backtest] fatal:", err);
  process.exit(1);
});
