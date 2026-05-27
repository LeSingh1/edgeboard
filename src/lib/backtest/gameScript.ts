/**
 * Game-script / blowout adjustment.
 *
 * When a game gets out of hand, starters on the losing side sit through
 * garbage time and bench guys eat their minutes — and the reverse for the
 * winning side, where the starters cruise but the bench piles on stats.
 * The rolling-baseline model has no idea this is coming; it just predicts
 * the player's season average.
 *
 * We learn the residual (actual − rolling-baseline) per
 * (team-result × margin × role) bucket from the season corpus:
 *
 *   { win, loss } × { close, decisive, blowout } × { starter, bench }
 *
 * Trained once per backtest run from `data/backtest/gamelogs.json` by
 * `scripts/analyze-game-script.ts` and written to
 * `data/backtest/gameScriptProfile.json`. Live process loads lazily.
 */

export type GameScriptBucket =
  | "win-close-starter" | "win-close-bench"
  | "win-decisive-starter" | "win-decisive-bench"
  | "win-blowout-starter" | "win-blowout-bench"
  | "loss-close-starter" | "loss-close-bench"
  | "loss-decisive-starter" | "loss-decisive-bench"
  | "loss-blowout-starter" | "loss-blowout-bench";

export type MarginBucket = "close" | "decisive" | "blowout";
export type RoleBucket = "starter" | "bench";

export interface GameScriptCell {
  /** Mean residual (actual − rolling baseline) in this bucket. */
  mean: number;
  /** Number of player-games observed in this bucket. */
  n: number;
}

export interface GameScriptProfile {
  generatedAt: string;
  /** stat → bucketKey → cell. */
  byStat: Record<string, Partial<Record<GameScriptBucket, GameScriptCell>>>;
}

/** Margin bucket from a final-score margin (absolute, in points). */
export function bucketFor(margin: number): MarginBucket {
  const m = Math.abs(margin);
  if (m <= 7) return "close";
  if (m <= 15) return "decisive";
  return "blowout";
}

/** Build the canonical bucket key for a (team-result, margin, role) triple. */
export function bucketKey(
  teamWillWin: boolean,
  margin: number,
  role: RoleBucket,
): GameScriptBucket {
  const side = teamWillWin ? "win" : "loss";
  return `${side}-${bucketFor(margin)}-${role}` as GameScriptBucket;
}

/**
 * Look up the additive residual to apply to a projection mean. Returns
 * `null` if we don't have the stat in the profile or the bucket sample
 * is too thin. Caller multiplies by confidence + decides whether to fire.
 */
export function gameScriptDelta(
  profile: GameScriptProfile | null,
  params: {
    stat: string;
    expectedMargin: number;
    teamWillWin: boolean;
    isStarter: boolean;
  },
): { delta: number; sample: number; bucket: GameScriptBucket } | null {
  if (!profile) return null;
  const row = profile.byStat[params.stat];
  if (!row) return null;
  const key = bucketKey(
    params.teamWillWin,
    params.expectedMargin,
    params.isStarter ? "starter" : "bench",
  );
  const cell = row[key];
  if (!cell) return null;
  return { delta: cell.mean, sample: cell.n, bucket: key };
}

/**
 * Estimate the final margin for a target game from per-team offensive/defensive
 * profiles. Both `home` and `away` carry that team's mean points-per-game
 * (offRating) and mean points-allowed-per-game (defRating); a team's expected
 * score is the average of its own offense and the opponent's defense, and the
 * margin is the difference.
 *
 * Returns the signed margin from the perspective of `team` (positive = team
 * expected to win, negative = expected to lose). `null` if either side's
 * profile is incomplete.
 */
export interface TeamScoringProfile {
  /** Mean team points-per-game when this team plays. */
  offRating: number;
  /** Mean team points allowed-per-game when this team plays. */
  defRating: number;
  /** Number of games observed. */
  gamesObserved: number;
}

export interface TeamScoring {
  generatedAt: string;
  /** Per-team profile keyed by uppercase team abbreviation. */
  byTeam: Record<string, TeamScoringProfile>;
  /** League-mean PPG (sanity check + fallback). */
  leagueAvg: number;
}

export function expectedMarginFor(
  scoring: TeamScoring | null,
  teamAbbr: string | undefined,
  opponentAbbr: string | undefined,
): { margin: number; sample: number } | null {
  if (!scoring || !teamAbbr || !opponentAbbr) return null;
  const a = scoring.byTeam[teamAbbr.toUpperCase()];
  const b = scoring.byTeam[opponentAbbr.toUpperCase()];
  if (!a || !b || a.gamesObserved < 10 || b.gamesObserved < 10) return null;
  // Expected team score = (own offense + opp defense) / 2 — same balanced
  // blend used by basketball-reference's predicted-points formula.
  const teamExpected = (a.offRating + b.defRating) / 2;
  const oppExpected = (b.offRating + a.defRating) / 2;
  return {
    margin: teamExpected - oppExpected,
    sample: Math.min(a.gamesObserved, b.gamesObserved),
  };
}
