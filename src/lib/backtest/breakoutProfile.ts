/**
 * Per-player breakout-rate profiles, computed from the cached gamelogs.
 *
 * A "breakout" is a game where the player exceeded their rolling-mean by
 * ≥ `Z_THRESHOLD` standard deviations (default 1.5σ). We aggregate
 * breakouts per (player, stat) and bucket by situational context — so the
 * live model can answer questions like:
 *
 *   "What's Jalen Brunson's breakout rate on Points against strong
 *    defenses, in playoff games?"
 *
 * Used by both the live `applyAdjustments` (via `applyBreakoutProfile.ts`)
 * and the backtest `scoreModel` (to keep the calibration fit on a model
 * that sees this signal).
 */

import { ESPN_BASKETBALL_STATS } from "@/lib/realProjections";
import type { PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";
import { isPlayoffDate } from "@/lib/playoffWindow";
import { defensiveDelta, type DefenseRatings } from "@/lib/backtest/defenseRatings";

const Z_THRESHOLD = 1.5;
const MIN_PRIOR_FOR_BREAKOUT = 8;

export type DefenseBucket = "strong" | "average" | "weak";

export interface BreakoutCell {
  games: number;
  breakouts: number;
  /** breakouts / games, 0 if games === 0 */
  rate: number;
}

export interface PerStatBreakout {
  games: number;
  breakouts: number;
  rate: number;
  byOpponentDefense: Record<DefenseBucket, BreakoutCell>;
  byPlayoff: { playoff: BreakoutCell; regular: BreakoutCell };
  byHomeAway: { home: BreakoutCell; away: BreakoutCell };
}

export interface PlayerBreakoutProfile {
  totalObservations: number;
  perStat: Record<string, PerStatBreakout>;
}

export interface BreakoutProfiles {
  generatedAt: string;
  /** League-wide breakout rate per stat — the baseline a player's rate
   *  is compared to. Aggregated across all players. */
  baseline: Record<string, BreakoutCell>;
  /** Per-player profiles keyed by exact ESPN display name. */
  byPlayer: Record<string, PlayerBreakoutProfile>;
}

const TRACKED_STATS = [
  "Points",
  "Rebounds",
  "Assists",
  "3-PT Made",
  "Steals",
  "Blocks",
  "Pts+Rebs",
  "Pts+Asts",
  "Rebs+Asts",
  "Pts+Rebs+Asts",
];

function emptyCell(): BreakoutCell {
  return { games: 0, breakouts: 0, rate: 0 };
}

function emptyPerStat(): PerStatBreakout {
  return {
    games: 0,
    breakouts: 0,
    rate: 0,
    byOpponentDefense: {
      strong: emptyCell(),
      average: emptyCell(),
      weak: emptyCell(),
    },
    byPlayoff: { playoff: emptyCell(), regular: emptyCell() },
    byHomeAway: { home: emptyCell(), away: emptyCell() },
  };
}

export function defenseBucketFromDelta(delta: number | null): DefenseBucket {
  if (delta === null) return "average";
  if (delta <= -1) return "strong";
  if (delta >= 1) return "weak";
  return "average";
}

function record(cell: BreakoutCell, isBreakout: boolean) {
  cell.games += 1;
  if (isBreakout) cell.breakouts += 1;
}

function finalizeCell(cell: BreakoutCell) {
  cell.rate = cell.games > 0 ? cell.breakouts / cell.games : 0;
}

function finalizePerStat(s: PerStatBreakout) {
  s.rate = s.games > 0 ? s.breakouts / s.games : 0;
  for (const k of ["strong", "average", "weak"] as DefenseBucket[]) finalizeCell(s.byOpponentDefense[k]);
  finalizeCell(s.byPlayoff.playoff);
  finalizeCell(s.byPlayoff.regular);
  finalizeCell(s.byHomeAway.home);
  finalizeCell(s.byHomeAway.away);
}

export function buildBreakoutProfiles(
  players: PlayerGamelog[],
  defense: DefenseRatings | null,
): BreakoutProfiles {
  const byPlayer: Record<string, PlayerBreakoutProfile> = {};
  const baseline: Record<string, BreakoutCell> = {};
  for (const stat of TRACKED_STATS) baseline[stat] = emptyCell();

  for (const player of players) {
    const meta = new Map(player.metaPairs);
    const eventsChrono = [...player.events].reverse();
    const profile: PlayerBreakoutProfile = {
      totalObservations: 0,
      perStat: {},
    };

    for (const stat of TRACKED_STATS) {
      const extractor = ESPN_BASKETBALL_STATS[stat];
      if (!extractor) continue;
      const perStat = emptyPerStat();

      const values: number[] = [];
      for (let i = 0; i < eventsChrono.length; i++) {
        const ev = eventsChrono[i];
        const v = extractor(ev.stats, player.labels);
        if (!Number.isFinite(v) || v < 0) {
          values.push(NaN);
          continue;
        }
        values.push(v);

        // Need ≥ MIN prior games to define a rolling mean+std
        const prior = values.slice(0, i).filter((x) => Number.isFinite(x));
        if (prior.length < MIN_PRIOR_FOR_BREAKOUT) continue;
        const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
        const std = Math.sqrt(
          prior.reduce((a, b) => a + (b - mean) ** 2, 0) / prior.length,
        );
        if (std < 0.1) continue;
        const z = (v - mean) / std;
        const isBreakout = z >= Z_THRESHOLD;

        // Context
        const m = meta.get(ev.eventId);
        const date = m?.gameDate ?? "";
        const opp = (m?.opponentAbbr ?? "").toUpperCase();
        const dd = opp && defense ? defensiveDelta(defense, opp, stat) : null;
        const defBucket = defenseBucketFromDelta(dd?.delta ?? null);
        const isPlayoff = isPlayoffDate(date);
        const homeAway = m?.atVs === "vs" ? "home" : m?.atVs === "@" ? "away" : null;

        // Record into every applicable cell
        record(perStat, isBreakout);
        record(baseline[stat], isBreakout);
        record(perStat.byOpponentDefense[defBucket], isBreakout);
        record(perStat.byPlayoff[isPlayoff ? "playoff" : "regular"], isBreakout);
        if (homeAway) record(perStat.byHomeAway[homeAway], isBreakout);
        profile.totalObservations += 1;
      }

      finalizePerStat(perStat);
      if (perStat.games > 0) profile.perStat[stat] = perStat;
    }

    if (profile.totalObservations > 0) byPlayer[player.name] = profile;
  }

  for (const stat of TRACKED_STATS) finalizeCell(baseline[stat]);

  return {
    generatedAt: new Date().toISOString(),
    baseline,
    byPlayer,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Pure shift lookup — used by both live (applyAdjustments) and backtest
// (scoreModel) so the math is one source of truth.
// ────────────────────────────────────────────────────────────────────────

export interface BreakoutSignalConfig {
  /** Minimum bucket sample size to fire. */
  minSample: number;
  /** Multiplier above league baseline that counts as "elevated". */
  elevationMultiplier: number;
  /** Cap on the magnitude of the resulting bucket rate excess (rate − baseline). */
  maxExcess: number;
}

export const DEFAULT_BREAKOUT_CONFIG: BreakoutSignalConfig = {
  minSample: 5,
  elevationMultiplier: 1.3,
  maxExcess: 0.25,
};

/**
 * Compute a breakout shift for a given (player, stat, context). Returns
 * the EXCESS breakout rate (player's rate minus baseline) in the best
 * matching bucket, capped, sample-gated. The caller multiplies by σ × confidence.
 */
export function breakoutExcess(args: {
  profiles: BreakoutProfiles;
  playerName: string;
  stat: string;
  context: {
    opponentDefenseDelta: number | null;
    isHome: boolean | undefined;
    isPlayoff: boolean;
  };
  config?: BreakoutSignalConfig;
}): { excess: number; sample: number; bucket: string } | null {
  const cfg = args.config ?? DEFAULT_BREAKOUT_CONFIG;
  const profile = args.profiles.byPlayer[args.playerName];
  if (!profile) return null;
  const perStat = profile.perStat[args.stat];
  if (!perStat) return null;
  const base = args.profiles.baseline[args.stat]?.rate ?? 0;
  if (base <= 0) return null;

  // Pick the most specific bucket with sufficient sample size, walking
  // from most-specific to least-specific. The current context-bucket
  // hierarchy: playoff slot, then opp-defense slot, then home/away, then
  // overall per-stat as fallback.
  const tries: Array<{ cell: BreakoutCell; label: string }> = [
    { cell: perStat.byPlayoff[args.context.isPlayoff ? "playoff" : "regular"], label: args.context.isPlayoff ? "playoff" : "regular" },
    { cell: perStat.byOpponentDefense[defenseBucketFromDelta(args.context.opponentDefenseDelta)], label: `${defenseBucketFromDelta(args.context.opponentDefenseDelta)}-defense` },
    args.context.isHome !== undefined
      ? { cell: perStat.byHomeAway[args.context.isHome ? "home" : "away"], label: args.context.isHome ? "home" : "away" }
      : null,
    { cell: { games: perStat.games, breakouts: perStat.breakouts, rate: perStat.rate }, label: "overall" },
  ].filter((x): x is { cell: BreakoutCell; label: string } => !!x);

  for (const t of tries) {
    if (t.cell.games < cfg.minSample) continue;
    if (t.cell.rate < base * cfg.elevationMultiplier) continue;
    const rawExcess = t.cell.rate - base;
    if (rawExcess <= 0) continue;
    return {
      excess: Math.min(cfg.maxExcess, rawExcess),
      sample: t.cell.games,
      bucket: t.label,
    };
  }
  return null;
}
