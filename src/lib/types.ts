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
  gameTime: string;            // ISO string
  statType: string;            // "Points", "Pass Yards", "Hitter Strikeouts"
  line: number;
  status: "active" | "locked" | "settled";
  oddsType: OddsType;          // PrizePicks-tagged odds modifier
  isPromo?: boolean;
  isLive?: boolean;
  // ── Implied probability surface ──
  pMore: number;               // 0..1, derived from oddsType (PrizePicks-implied)
  pLess: number;               // 0..1
  modelVersion: string;        // 'implied-v1' | 'xgb-v1' (future)
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
