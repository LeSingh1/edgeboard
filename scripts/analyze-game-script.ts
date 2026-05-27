#!/usr/bin/env tsx
/**
 * Game-script profile builder (standalone CLI).
 *
 * Reads cached gamelogs, runs the shared builder, writes the profile +
 * team-scoring tables to disk. Same builder runs inside `scripts/backtest.ts`,
 * so calibration sees the signal during fit. Run this on its own to refresh
 * just the game-script artifacts without re-running the full backtest.
 *
 *   npx tsx scripts/analyze-game-script.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SeasonLogsCache } from "@/lib/backtest/fetchSeasonLogs";
import { buildGameScript } from "@/lib/backtest/gameScriptBuilder";
import type { GameScriptCell } from "@/lib/backtest/gameScript";

const DATA_DIR = path.join(process.cwd(), "data", "backtest");
const GAMELOGS_PATH = path.join(DATA_DIR, "gamelogs.json");
const PROFILE_PATH = path.join(DATA_DIR, "gameScriptProfile.json");
const SCORING_PATH = path.join(DATA_DIR, "teamScoring.json");

async function main() {
  const t0 = Date.now();
  console.log("[game-script] loading gamelogs…");
  const raw = await fs.readFile(GAMELOGS_PATH, "utf8");
  const cache = JSON.parse(raw) as SeasonLogsCache;
  console.log(`[game-script] ${cache.players.length} players loaded`);

  const { profile, scoring, coverage, observations } = buildGameScript(cache.players);
  console.log(
    `[game-script] margin coverage: ${coverage.bothSides} both-sides, ${coverage.oneSide} one-side skipped`,
  );
  console.log(`[game-script] processed ${observations.toLocaleString()} player-game residuals`);

  await fs.writeFile(SCORING_PATH, JSON.stringify(scoring, null, 2));
  console.log(`[game-script] wrote ${SCORING_PATH} (${Object.keys(scoring.byTeam).length} teams)`);
  await fs.writeFile(PROFILE_PATH, JSON.stringify(profile, null, 2));
  console.log(`[game-script] wrote ${PROFILE_PATH}`);

  // ── Console summary ───────────────────────────────────────────────
  console.log("");
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  Game-script residual buckets (mean residual · sample size)");
  console.log("──────────────────────────────────────────────────────────────");
  const bucketOrder = [
    "win-close-starter", "win-close-bench",
    "win-decisive-starter", "win-decisive-bench",
    "win-blowout-starter", "win-blowout-bench",
    "loss-close-starter", "loss-close-bench",
    "loss-decisive-starter", "loss-decisive-bench",
    "loss-blowout-starter", "loss-blowout-bench",
  ];
  for (const stat of Object.keys(profile.byStat)) {
    console.log(`  ${stat}`);
    const row = profile.byStat[stat] as Record<string, GameScriptCell>;
    for (const key of bucketOrder) {
      const cell = row[key];
      if (!cell) {
        console.log(`    ${key.padEnd(26)}     — (insufficient sample)`);
        continue;
      }
      const sign = cell.mean >= 0 ? "+" : "";
      console.log(
        `    ${key.padEnd(26)} ${sign}${cell.mean.toFixed(2).padStart(6)}   n=${cell.n}`,
      );
    }
  }
  console.log(`  Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("[game-script] fatal:", err);
  process.exit(1);
});
