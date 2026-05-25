#!/usr/bin/env tsx
/**
 * Single-player smoke test for the backtest pipeline.
 *
 * Hardcodes one well-known NBA player, runs the full pipeline (fetch
 * → synthesize → score → aggregate → fit), and prints a summary. Lets
 * us validate the pipeline end-to-end without waiting for the full
 * 450-player fetch.
 *
 * Run:  npx tsx scripts/backtest-smoke.ts
 */

import { espnFindAthleteId, espnGameLog } from "@/lib/realProjections";
import { synthesizePlayerRows } from "@/lib/backtest/synthesizeLines";
import { scoreModel } from "@/lib/backtest/scoreModel";
import { aggregate, type ScoredPick } from "@/lib/backtest/aggregate";
import { fitCalibration } from "@/lib/backtest/fitCalibration";
import type { PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";

const TEST_PLAYER = "LeBron James";

async function main() {
  console.log(`[smoke] resolving ${TEST_PLAYER}…`);
  const id = await espnFindAthleteId(TEST_PLAYER, "nba");
  if (!id) {
    console.error(`[smoke] couldn't resolve ${TEST_PLAYER} on ESPN`);
    process.exit(1);
  }
  console.log(`[smoke] resolved id=${id}`);

  console.log(`[smoke] fetching gamelog…`);
  const { labels, events, meta } = await espnGameLog(id, "nba");
  console.log(`[smoke] got ${events.length} games, ${labels.length} stat labels`);

  if (events.length < 20) {
    console.error(`[smoke] need ≥20 games for a meaningful smoke test`);
    process.exit(1);
  }

  const player: PlayerGamelog = {
    name: TEST_PLAYER,
    team: "?",
    espnId: id,
    labels,
    events,
    metaPairs: Array.from(meta.entries()),
  };

  const rows = synthesizePlayerRows(player);
  console.log(`[smoke] synthesized ${rows.length} rows`);

  const picks: ScoredPick[] = [];
  for (const row of rows) {
    for (const v of [
      { key: "standardLine", oddsType: "standard" as const },
      { key: "goblinLine", oddsType: "goblin" as const },
      { key: "demonLine", oddsType: "demon" as const },
    ]) {
      const line = (row as unknown as Record<string, number>)[v.key];
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
      if (!out) continue;
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
    }
  }
  console.log(`[smoke] scored ${picks.length} picks`);

  const report = aggregate(picks);
  const cal = fitCalibration(picks.map((p) => ({ predicted: p.predictedPMore, hit: p.hit })));

  console.log("");
  console.log(`──────────── ${TEST_PLAYER} · smoke ────────────`);
  console.log(`Total picks: ${report.totalPicks}`);
  console.log(`Mean predicted: ${(report.syntheticPL.meanPredicted * 100).toFixed(1)}%`);
  console.log(`Actual hit rate: ${(report.syntheticPL.overallHitRate * 100).toFixed(1)}%`);
  console.log(`Global residual: ${(report.syntheticPL.meanResidual * 100).toFixed(2)}%`);
  console.log("");
  console.log("Buckets:");
  for (const b of report.buckets) {
    if (b.n === 0) {
      console.log(`  ${b.range}    —`);
      continue;
    }
    console.log(
      `  ${b.range}    predicted ${(b.meanPredicted * 100).toFixed(1)}%  actual ${(b.actualHitRate * 100).toFixed(1)}%  residual ${(b.residual * 100).toFixed(1)}%  n=${b.n}`,
    );
  }
  console.log("");
  console.log(`Calibration breakpoints: ${cal.breakpoints.length}`);
  console.log("");

  // Sanity: high-prob bucket should have higher hit rate than low-prob bucket.
  const nonempty = report.buckets.filter((b) => b.n >= 5);
  if (nonempty.length >= 2) {
    const lo = nonempty[0];
    const hi = nonempty[nonempty.length - 1];
    if (hi.actualHitRate < lo.actualHitRate) {
      console.warn(
        `[smoke] WARNING: top bucket (${(hi.actualHitRate * 100).toFixed(1)}%) hit rate < ` +
          `bottom bucket (${(lo.actualHitRate * 100).toFixed(1)}%). Model may be broken.`,
      );
    } else {
      console.log(
        `[smoke] sanity check passed: top bucket hit rate > bottom bucket (model is directionally correct)`,
      );
    }
  }
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
