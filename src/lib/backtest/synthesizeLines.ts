/**
 * Synthetic line generator for backtesting.
 *
 * Real PrizePicks lines aren't available historically, so we fake them
 * using the player's own rolling history up to (but not including) the
 * target game. For each (player, game), we emit three line variants
 * mirroring PP's odds_type schema:
 *
 *   standard  = median of prior games  (≈ 50/50)
 *   goblin    = median − 0.5σ          (easier, MORE more likely)
 *   demon     = median + 0.5σ          (harder, MORE less likely)
 *
 * Rounded to the nearest .5 to match PP's no-whole-number rule. The
 * backtest is honest about being synthetic in the spec — the value is
 * calibration, not edge.
 */

import { ESPN_BASKETBALL_STATS } from "@/lib/realProjections";
import type { PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";

export interface BacktestRow {
  player: string;
  team: string;
  /** ISO date of the target game. */
  date: string;
  /** The PrizePicks-style stat name we're synthesizing a line for. */
  stat: string;
  /** Three synthetic lines, one per oddsType. */
  standardLine: number;
  goblinLine: number;
  demonLine: number;
  /** Actual stat value the player put up that game — the label we
   *  score predictions against. */
  actualValue: number;
  /** Opponent abbreviation, for vs-opp signal in scoreModel. */
  opponent?: string;
  /** "@" (away) or "vs" (home), for home/away signal in scoreModel. */
  atVs?: string;
  /** Chronological index of this game in the player's gamelog (0 = oldest).
   *  Lets scoreModel slice the prior-only window cleanly. */
  chronoIndex: number;
}

/** Stats we backtest. Subset of ESPN_BASKETBALL_STATS keyed by PP-style
 *  display name. Restricted to the ones PrizePicks actually ships for NBA
 *  (skipping Minutes / FG Made etc. that PP doesn't list). */
const BACKTEST_STATS = [
  "Points",
  "Rebounds",
  "Assists",
  "Pts+Rebs",
  "Pts+Asts",
  "Rebs+Asts",
  "Pts+Rebs+Asts",
  "3-PT Made",
  "Steals",
  "Blocks",
  "Turnovers",
  "Fantasy Score",
] as const;

/** Round to the nearest .5. Matches PrizePicks's no-whole-number convention. */
function roundToHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

/** Sample mean + std-dev of a number array. Population variance, not Bessel-corrected —
 *  same convention as the live model's meanStd. */
function meanStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Generate backtest rows for a single player across the entire season.
 * For each game N (with N ≥ 8), uses games [0..N-1] to synthesize lines,
 * then records the actual value at game N as the label.
 */
export function synthesizePlayerRows(player: PlayerGamelog): BacktestRow[] {
  const rows: BacktestRow[] = [];

  // Build the chronological ordering. ESPN's gamelog comes newest-first; we
  // reverse to oldest-first so chronoIndex 0 = season opener, and "prior
  // games" = slice(0, N).
  const meta = new Map(player.metaPairs);
  const eventsChrono = [...player.events].reverse();
  const dates = eventsChrono.map((e) => meta.get(e.eventId)?.gameDate ?? "");
  const opponents = eventsChrono.map((e) => meta.get(e.eventId)?.opponentAbbr);
  const atVsList = eventsChrono.map((e) => meta.get(e.eventId)?.atVs);

  for (const statName of BACKTEST_STATS) {
    const extractor = ESPN_BASKETBALL_STATS[statName];
    if (!extractor) continue;

    // Per-game values in chronological order.
    const chronoValues = eventsChrono.map((e) => extractor(e.stats, player.labels));

    for (let n = 0; n < chronoValues.length; n++) {
      const prior = chronoValues.slice(0, n);
      // Same minimum-sample threshold as buildResult() in realProjections.
      if (prior.length < 8) continue;
      const { mean, std } = meanStd(prior);
      const sigma = Math.max(std, mean * 0.15, 0.5);

      const standardLine = roundToHalf(mean);
      const goblinLine = roundToHalf(mean - 0.5 * sigma);
      const demonLine = roundToHalf(mean + 0.5 * sigma);

      // Skip degenerate lines (e.g. a player who never registers blocks
      // would produce a 0.5 line on a 0 mean — uninformative).
      if (standardLine < 0.5) continue;

      rows.push({
        player: player.name,
        team: player.team,
        date: dates[n] || "",
        stat: statName,
        standardLine,
        goblinLine: Math.max(0.5, goblinLine),
        demonLine,
        actualValue: chronoValues[n],
        opponent: opponents[n],
        atVs: atVsList[n],
        chronoIndex: n,
      });
    }
  }

  return rows;
}

/** Convenience: run synthesizePlayerRows across the whole season. */
export function synthesizeAllRows(players: PlayerGamelog[]): BacktestRow[] {
  const out: BacktestRow[] = [];
  for (const p of players) out.push(...synthesizePlayerRows(p));
  return out;
}
