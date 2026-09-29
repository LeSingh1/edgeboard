/**
 * Shared vocabulary for the Line Betting tab.
 *
 * PrizePicks, sportsbooks (via The Odds API) and Kalshi all name the same
 * stat differently ("Rec Yards" / "player_reception_yds" / "Receiving Yards").
 * Everything is folded into one canonical key per stat so the three sources
 * can be lined up against each other.
 */

/** PrizePicks league → Odds API sport key. Only FULL-GAME leagues: a
 *  sportsbook's full-game line says nothing about an NBA1Q / NFL1H prop. */
export const LEAGUE_TO_ODDS_SPORT: Record<string, string> = {
  NFL: "americanfootball_nfl",
  CFB: "americanfootball_ncaaf",
  NCAAF: "americanfootball_ncaaf",
  NBA: "basketball_nba",
  WNBA: "basketball_wnba",
  MLB: "baseball_mlb",
  NHL: "icehockey_nhl",
};

/** Kalshi ticker prefix per PrizePicks league (series look like KXNFLREC). */
export const LEAGUE_TO_KALSHI_PREFIX: Record<string, string> = {
  NFL: "KXNFL",
  CFB: "KXNCAAF",
  NCAAF: "KXNCAAF",
  NBA: "KXNBA",
  WNBA: "KXWNBA",
  MLB: "KXMLB",
  NHL: "KXNHL",
};

export type SportFamily = "football" | "basketball" | "baseball" | "hockey";

export function familyOf(league: string): SportFamily | null {
  const l = league.toUpperCase();
  if (l === "NFL" || l === "CFB" || l === "NCAAF") return "football";
  if (l === "NBA" || l === "WNBA") return "basketball";
  if (l === "MLB") return "baseball";
  if (l === "NHL") return "hockey";
  return null;
}

/** Squash a stat label to letters+digits+'+' so "Pts + Rebs" == "pts+rebs". */
export function normStatLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+]/g, "");
}

/**
 * PrizePicks stat label (normalized) → canonical stat, per sport family.
 * Anything not listed simply isn't line-shopped (fantasy score, 1H stats…).
 */
const PP_STATS: Record<SportFamily, Record<string, string>> = {
  football: {
    passyards: "pass_yds", passingyards: "pass_yds",
    passtds: "pass_tds", passingtds: "pass_tds", passtd: "pass_tds",
    passattempts: "pass_att",
    passcompletions: "pass_cmp",
    int: "pass_int", ints: "pass_int", passints: "pass_int", interceptions: "pass_int",
    rushyards: "rush_yds", rushingyards: "rush_yds",
    rushattempts: "rush_att",
    receptions: "rec",
    recyards: "rec_yds", receivingyards: "rec_yds",
    "rush+recyds": "rush_rec_yds", "rush+recyards": "rush_rec_yds",
    "pass+rushyds": "pass_rush_yds", "pass+rushyards": "pass_rush_yds",
  },
  basketball: {
    points: "points", pts: "points",
    rebounds: "rebounds", rebs: "rebounds",
    assists: "assists", asts: "assists",
    "3ptmade": "threes", "3ptm": "threes", "3pt": "threes", threes: "threes",
    blockedshots: "blocks", blocks: "blocks", blks: "blocks",
    steals: "steals", stls: "steals",
    "pts+rebs+asts": "pra", pra: "pra",
    "pts+rebs": "pr", "pts+asts": "pa", "rebs+asts": "ra",
    "blks+stls": "stocks",
    turnovers: "turnovers",
  },
  baseball: {
    hits: "hits",
    totalbases: "total_bases",
    "hits+runs+rbis": "hrr",
    rbis: "rbis",
    runs: "runs",
    hitterstrikeouts: "batter_ks",
    pitcherstrikeouts: "pitcher_ks", strikeouts: "pitcher_ks",
    pitchingouts: "pitcher_outs", pitcherouts: "pitcher_outs",
    hitsallowed: "hits_allowed", pitcherhitsallowed: "hits_allowed",
    walksallowed: "walks_allowed", pitcherwalks: "walks_allowed",
    earnedrunsallowed: "earned_runs",
  },
  hockey: {
    points: "points",
    goals: "goals",
    assists: "assists",
    shotsongoal: "sog", shots: "sog",
    blockedshots: "blocked_shots",
    goaliesaves: "saves", saves: "saves",
  },
};

export function canonicalStat(league: string, ppStatType: string): string | null {
  const fam = familyOf(league);
  if (!fam) return null;
  return PP_STATS[fam][normStatLabel(ppStatType)] ?? null;
}

/** Canonical stat → The Odds API market key, per sport family. */
export const ODDS_MARKETS: Record<SportFamily, Record<string, string>> = {
  football: {
    pass_yds: "player_pass_yds",
    pass_tds: "player_pass_tds",
    pass_att: "player_pass_attempts",
    pass_cmp: "player_pass_completions",
    pass_int: "player_pass_interceptions",
    rush_yds: "player_rush_yds",
    rush_att: "player_rush_attempts",
    rec: "player_receptions",
    rec_yds: "player_reception_yds",
    rush_rec_yds: "player_rush_reception_yds",
    pass_rush_yds: "player_pass_rush_yds",
  },
  basketball: {
    points: "player_points",
    rebounds: "player_rebounds",
    assists: "player_assists",
    threes: "player_threes",
    blocks: "player_blocks",
    steals: "player_steals",
    pra: "player_points_rebounds_assists",
    pr: "player_points_rebounds",
    pa: "player_points_assists",
    ra: "player_rebounds_assists",
    stocks: "player_blocks_steals",
    turnovers: "player_turnovers",
  },
  baseball: {
    hits: "batter_hits",
    total_bases: "batter_total_bases",
    hrr: "batter_hits_runs_rbis",
    rbis: "batter_rbis",
    runs: "batter_runs_scored",
    batter_ks: "batter_strikeouts",
    pitcher_ks: "pitcher_strikeouts",
    pitcher_outs: "pitcher_outs",
    hits_allowed: "pitcher_hits_allowed",
    walks_allowed: "pitcher_walks",
    earned_runs: "pitcher_earned_runs",
  },
  hockey: {
    points: "player_points",
    goals: "player_goals",
    assists: "player_assists",
    sog: "player_shots_on_goal",
    blocked_shots: "player_blocked_shots",
    saves: "player_total_saves",
  },
};

/** Reverse lookup: Odds API market key → canonical stat for a family. */
export function canonicalFromOddsMarket(fam: SportFamily, market: string): string | null {
  for (const [canon, key] of Object.entries(ODDS_MARKETS[fam])) if (key === market) return canon;
  return null;
}

/**
 * Keyword rules used to recognize a Kalshi series by its title
 * ("Pro Football: Receiving Yards"). Order matters — combos before singles.
 */
export const KALSHI_TITLE_RULES: Array<{ fam: SportFamily; re: RegExp; canon: string }> = [
  { fam: "football", re: /rush(ing)?\s*\+?\s*(and\s*)?rec(eiving)?\s*yards/i, canon: "rush_rec_yds" },
  { fam: "football", re: /pass(ing)?\s*yards/i, canon: "pass_yds" },
  { fam: "football", re: /pass(ing)?\s*(touchdowns|tds)/i, canon: "pass_tds" },
  { fam: "football", re: /pass(ing)?\s*attempts/i, canon: "pass_att" },
  { fam: "football", re: /(pass(ing)?\s*)?completions/i, canon: "pass_cmp" },
  { fam: "football", re: /interceptions/i, canon: "pass_int" },
  { fam: "football", re: /rush(ing)?\s*yards/i, canon: "rush_yds" },
  { fam: "football", re: /rush(ing)?\s*attempts|carries/i, canon: "rush_att" },
  { fam: "football", re: /rec(eiving)?\s*yards/i, canon: "rec_yds" },
  { fam: "football", re: /receptions/i, canon: "rec" },
  { fam: "basketball", re: /points.*rebounds.*assists|pra\b/i, canon: "pra" },
  { fam: "basketball", re: /three|3pt|3-point/i, canon: "threes" },
  { fam: "basketball", re: /rebounds/i, canon: "rebounds" },
  { fam: "basketball", re: /assists/i, canon: "assists" },
  { fam: "basketball", re: /points/i, canon: "points" },
  { fam: "baseball", re: /total\s*bases/i, canon: "total_bases" },
  { fam: "baseball", re: /strikeouts/i, canon: "pitcher_ks" },
  { fam: "baseball", re: /hits/i, canon: "hits" },
  { fam: "hockey", re: /shots\s*on\s*goal/i, canon: "sog" },
  { fam: "hockey", re: /saves/i, canon: "saves" },
  { fam: "hockey", re: /goals/i, canon: "goals" },
  { fam: "hockey", re: /points/i, canon: "points" },
];

/** Rough coefficient of variation per stat, used only to translate a
 *  sportsbook price at one line (e.g. 250.5) to PrizePicks' line (245.5). */
const CV: Record<string, number> = {
  pass_yds: 0.28, rush_yds: 0.55, rec_yds: 0.6, rush_rec_yds: 0.5, pass_rush_yds: 0.28,
  pass_att: 0.2, pass_cmp: 0.22, rush_att: 0.35, rec: 0.45,
  points: 0.33, rebounds: 0.42, assists: 0.48, pra: 0.28, pr: 0.3, pa: 0.32, ra: 0.38,
  pitcher_outs: 0.2, pitcher_ks: 0.38, sog: 0.55, saves: 0.25,
};

/** Estimated SD of the stat around a line — Poisson floor for small counts. */
export function statSd(canon: string, line: number): number {
  const cv = CV[canon] ?? 0.45;
  return Math.max(Math.sqrt(Math.max(line, 0.5)) * 1.05, cv * line, 0.6);
}

/** Normalize a person's name so "Kenneth Walker III" == "Kenneth Walker",
 *  "Amon-Ra St. Brown" == "amon ra st brown", "Janelle Salaün" == "janelle salaun". */
export function normPlayer(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/-/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
