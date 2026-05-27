export type Sport = string;

/**
 * PrizePicks tags every projection with an odds_type:
 *  - standard: the "true" line, implied ~50/50
 *  - demon:    line is HARDER than standard (line moved away from projection)
 *              → MORE is < 50% implied, payout × 1.25
 *  - goblin:   line is EASIER than standard (line moved toward projection)
 *              → MORE is > 50% implied, payout × 0.85
 */
export type OddsType = "standard" | "demon" | "goblin";

export interface Prop {
  id: string;
  source: "prizepicks" | "mock" | "manual" | "ocr";
  externalId?: string;
  sport: Sport;                // League name from PrizePicks: "NBA", "MLB", "NHL", "WNBA", etc.
  league: string;
  leagueIcon?: string;         // SVG URL from PrizePicks
  playerName: string;
  playerImage?: string | null;
  playerPosition?: string;
  playerTeamName?: string;     // Full team name like "Los Angeles Dodgers"
  isCombo?: boolean;           // Multi-player combo prop
  team: string;
  opponent: string;
  /** True when the player's team is the HOME team in this game. Undefined when we can't tell. */
  isHome?: boolean;
  gameTime: string;            // ISO string
  statType: string;            // "Points", "Pass Yards", "Hitter Strikeouts"
  line: number;
  status: "active" | "locked" | "settled";
  oddsType: OddsType;          // PrizePicks-tagged odds modifier
  isPromo?: boolean;
  isLive?: boolean;
  // ── PrizePicks metadata (passed through as-is) ──
  /**
   * PrizePicks's canonical projection family identifier — e.g.
   * `"188011-106-NBA_game_5wzqFAIAdZaOlCk7XW0fmwwY-11-false"`. Every projection
   * sharing this string is one ladder of rungs in PrizePicks's own app (the
   * goblin / standard / demon ladder a user sees when they tap a card).
   * This is the SOURCE OF TRUTH for grouping props into families — without it
   * we'd have to guess via `(player, statType, sport)` and risk merging
   * unrelated promo ladders.
   */
  groupKey?: string;
  /** Sequential ordering PP uses within a group_key — lower rank = higher line. */
  rank?: number;
  trendingCount?: number;      // Number of users who picked this prop
  flashSaleLine?: number | null; // Flash sale alternate line (if any)
  refundable?: boolean;        // Whether the prop can be refunded
  adjustedOdds?: boolean;      // Whether odds have been adjusted
  // ── Implied probability surface ──
  pMore: number;               // 0..1, derived from oddsType (PrizePicks-implied)
  pLess: number;               // 0..1
  modelVersion: string;        // 'implied-v1' | 'xgb-v1' (future)
  // ── Intel pre-computation (optional, populated client-side) ──
  /** Net pMore swing from press-conference / news intel (see /api/intel).
   *  When set, the projection API applies it AFTER the mean-based signals,
   *  baking it into the returned pMore and adding a "Press conference / news"
   *  row to the adjustments breakdown. Positive = intel favors MORE. */
  intelSwing?: number;
  /** Short evidence summary surfaced in the adjustments row. Optional. */
  intelEvidence?: string;
}

export type PickSide = "more" | "less";

export interface SelectedPick {
  propId: string;
  side: PickSide;
}

export type PlayType = "power" | "flex";
export type RiskMode = "safe" | "balanced" | "aggressive";

export interface Lineup {
  id: string;
  rank: number;
  picks: {
    prop: Prop;
    side: PickSide;
    probability: number;
  }[];
  hitProbability: number;
  expectedValue: number;
  grossPayout: number;
  netProfit: number;
  payoutMultiplier: number;
  correlationRisk: "low" | "medium" | "high";
  playType: PlayType;
  entryCost: number;
  status?: "draft" | "entered" | "won" | "lost" | "partial";
}

export interface LeagueSummary {
  name: string;
  count: number;
  icon?: string;
}
