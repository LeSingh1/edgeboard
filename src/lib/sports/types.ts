import type { Prop } from "@/lib/types";
import type { ProjectionResult, ProjectionAdjustment } from "@/lib/realProjections";

/** A single raw game from an external data source. Shape is per-sport.
 *
 *  Note: `stats` is intentionally typed as a flat Record rather than a generic
 *  `RawGame<TStats>` because adapter `extractStat()` already does the runtime
 *  parsing and the generic propagation would noise up every adapter signature
 *  without meaningful safety gain — extractors must runtime-validate anyway
 *  (the raw payload comes from external HTTP APIs). */
export interface RawGame {
  eventId: string;
  gameDate: string;             // ISO date string
  /** Sport-specific stat payload. Adapters know how to read it. */
  stats: Record<string, number | string | null>;
  opponentAbbr?: string;
  atVs?: "@" | "vs";
  isPlayoff?: boolean;
}

export interface PlayerRef {
  id: string;
  name: string;
  team?: string;
}

export interface DefenseRatings {
  /** Outer key is team abbreviation, inner key is statType, value is defensive
   *  rating delta from league average for that stat (positive = defense allows
   *  more than average, negative = stingier than average). */
  byTeam: Record<string, Record<string, number>>;
  /** Key is statType, value is league-average value for that stat. */
  leagueAvg: Record<string, number>;
}

export interface CalibrationTable {
  /** Key is `${stat}|${oddsType}` (e.g. `"points|over"`), value is an isotonic
   *  corrector mapping raw projection `x` to calibrated value `y`, plus the
   *  sampleSize the bucket was fit on. */
  buckets: Record<string, { x: number[]; y: number[]; sampleSize: number }>;
}

export interface BreakoutProfiles {
  /** Key is player ID, value is the list of breakout signals — one entry per
   *  stat the player shows a meaningful trend on. */
  byPlayerId: Record<string, { stat: string; trend: number; confidence: number }[]>;
}

export interface GameScriptProfile {
  /** Key is team abbreviation, value is the team's pace and offensive shift
   *  (relative to league baseline) under typical game script. */
  byTeam: Record<string, { pace: number; offensiveShift: number }>;
}

/** Held-out evaluation metrics computed on the test split (the most recent
 *  ~20% of each player's games, never seen by the calibrator). Lower
 *  `logLoss`/`brier` are better; if calibration helps, `logLoss` should beat
 *  `baselineLogLoss` (the raw uncalibrated probabilities). */
export interface TestMetrics {
  /** Number of test picks actually scored (those with a fitted bucket). */
  sampleSize: number;
  /** Distinct `${stat}|${oddsType}` buckets represented in the test set. */
  bucketsEvaluated: number;
  /** Mean log-loss using calibrated probabilities. */
  logLoss: number;
  /** Mean log-loss using raw (uncalibrated) probabilities, for comparison. */
  baselineLogLoss: number;
  /** Mean Brier score of the calibrated probabilities. */
  brier: number;
  /** Fraction of picks where the calibrated p≥0.5 decision matched the outcome. */
  accuracy: number;
}

export interface SportArtifacts {
  calibration: CalibrationTable | null;
  defenseRatings: DefenseRatings | null;
  breakoutProfiles: BreakoutProfiles | null;
  gameScriptProfile: GameScriptProfile | null;
  metadata: {
    trainedAt: string;
    /** Total picks generated (train + test). */
    sampleSize: number;
    /** Format: `"{sport}-{source}-v{N}"` with optional suffixes for variants.
     *  e.g. `"wnba-espn-v1+iso"`. */
    version: string;
    /** Picks in the training split (fed to the calibrator). */
    trainSampleSize?: number;
    /** Picks held out for evaluation. */
    testSampleSize?: number;
    /** Held-out test-set evaluation metrics. */
    testMetrics?: TestMetrics;
  };
}

/** Re-exported as `Adjustment` so sport adapter code reads with the local terminology
 *  ("this adjustment fires when..." rather than "this projection adjustment fires when..."). */
export type Adjustment = ProjectionAdjustment;

export interface SportAdapter {
  readonly leagues: string[];
  readonly displayName: string;
  readonly trainingSeasons: () => number[];
  readonly supportedStats: string[];

  /**
   * True only when `project()` resolves a REAL game-log projection FAST enough
   * to serve a single prop live (targeted player search + gamelog in ~1 request).
   * NBA/WNBA/MLB qualify. The other adapters' `fetchPlayerRoster` is a bulk
   * TRAINING loader (e.g. tennis ingests ~520 weeks of history per roster) and
   * their `project()` is a stub — so live they only produce the PrizePicks-
   * implied placeholder, which must never become a pick. The no-mock gate keys
   * off this flag: flip it true when a sport gets a genuine fast live projection
   * and `isLiveProjectionLeague` opens for it automatically.
   */
  readonly hasLiveProjection?: boolean;

  fetchPlayerRoster(): Promise<PlayerRef[]>;
  fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]>;
  /** Returns an array of ESPN event IDs for the given team's schedule in that season. */
  fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]>;

  /** Returns the stat value, or `null` if the stat is not present in this game
   *  (distinct from `0`, which means the stat is present and equal to zero). */
  extractStat(game: RawGame, statType: string): number | null;
  project(prop: Prop, artifacts: SportArtifacts): Promise<ProjectionResult>;

  recentFormAdjustment?(values: number[]): Adjustment | null;
  vsOpponentAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  homeAwayAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  daysRestAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  defenseAdjustment?(prop: Prop, ratings: DefenseRatings): Adjustment | null;
}
