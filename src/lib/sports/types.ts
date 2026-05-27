import type { Prop } from "@/lib/types";
import type { ProjectionResult, ProjectionAdjustment } from "@/lib/realProjections";

/** A single raw game from an external data source. Shape is per-sport. */
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
  byTeam: Record<string, Record<string, number>>;
  leagueAvg: Record<string, number>;
}

export interface CalibrationTable {
  buckets: Record<string, { x: number[]; y: number[]; sampleSize: number }>;
}

export interface BreakoutProfiles {
  byPlayerId: Record<string, { stat: string; trend: number; confidence: number }[]>;
}

export interface GameScriptProfile {
  byTeam: Record<string, { pace: number; offensiveShift: number }>;
}

export interface SportArtifacts {
  calibration: CalibrationTable | null;
  defenseRatings: DefenseRatings | null;
  breakoutProfiles: BreakoutProfiles | null;
  gameScriptProfile: GameScriptProfile | null;
  metadata: {
    trainedAt: string;
    sampleSize: number;
    version: string;
  };
}

export type Adjustment = ProjectionAdjustment;

export interface SportAdapter {
  readonly leagues: string[];
  readonly displayName: string;
  readonly trainingSeasons: () => number[];
  readonly supportedStats: string[];

  fetchPlayerRoster(): Promise<PlayerRef[]>;
  fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]>;
  fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]>;

  extractStat(game: RawGame, statType: string): number | null;
  project(prop: Prop, artifacts: SportArtifacts): Promise<ProjectionResult>;

  recentFormAdjustment?(values: number[]): Adjustment | null;
  vsOpponentAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  homeAwayAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  daysRestAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  defenseAdjustment?(prop: Prop, ratings: DefenseRatings): Adjustment | null;
}
