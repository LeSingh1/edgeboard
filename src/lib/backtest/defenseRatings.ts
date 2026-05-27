/**
 * Per-team-per-stat defensive ratings, computed from the cached gamelogs.
 *
 * For each player-game in the corpus, we observe `(opponent_team, stat,
 * value)` and aggregate by `(opponent_team, stat)` to get that team's
 * mean allowance to a typical opposing player. The league-wide mean
 * across all teams is the baseline — a team's "defensive rating" against
 * a stat is its `allowedPerGame − leagueAvg`. Negative = stingy defense,
 * positive = leaky defense.
 *
 * Used by:
 *   - `realProjections.ts` live: shifts a player's projection toward the
 *     opponent's allowance.
 *   - `scoreModel.ts` backtest: same shift, applied during scoring so the
 *     calibration is fit on the model WITH this signal.
 *
 * Trained once per backtest run and written to
 * `data/backtest/defenseRatings.json`. Live process loads lazily, same
 * pattern as `applyCalibration.ts`.
 */

import { ESPN_BASKETBALL_STATS } from "@/lib/realProjections";
import type { PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";

export interface DefenseRatings {
  generatedAt: string;
  /** Per-stat league mean — the baseline a per-team allowance is compared to. */
  leagueAvg: Record<string, { allowedPerGame: number; gamesObserved: number }>;
  /** team abbr → stat → mean allowance + sample size. */
  byTeam: Record<string, Record<string, { allowedPerGame: number; gamesObserved: number }>>;
}

/** Stat keys we materialize defensive ratings for. These are the heuristic
 *  model's primary projections; combo stats (Pts+Rebs, PRA) are derived
 *  on the fly from these atomic ones. */
const RATED_STATS = ["Points", "Rebounds", "Assists", "3-PT Made", "Steals", "Blocks"];

export function buildDefenseRatings(players: PlayerGamelog[]): DefenseRatings {
  // Accumulators: team -> stat -> { sum, n }
  const teamAcc = new Map<string, Map<string, { sum: number; n: number }>>();
  const leagueAcc = new Map<string, { sum: number; n: number }>();

  for (const p of players) {
    const eventsChrono = [...p.events].reverse();
    const meta = new Map(p.metaPairs);
    for (const ev of eventsChrono) {
      const m = meta.get(ev.eventId);
      const opp = m?.opponentAbbr;
      if (!opp) continue;
      const oppKey = opp.toUpperCase();
      let teamMap = teamAcc.get(oppKey);
      if (!teamMap) {
        teamMap = new Map();
        teamAcc.set(oppKey, teamMap);
      }
      for (const stat of RATED_STATS) {
        const extractor = ESPN_BASKETBALL_STATS[stat];
        if (!extractor) continue;
        const v = extractor(ev.stats, p.labels);
        if (!Number.isFinite(v) || v < 0) continue;
        let cell = teamMap.get(stat);
        if (!cell) {
          cell = { sum: 0, n: 0 };
          teamMap.set(stat, cell);
        }
        cell.sum += v;
        cell.n += 1;
        let leagueCell = leagueAcc.get(stat);
        if (!leagueCell) {
          leagueCell = { sum: 0, n: 0 };
          leagueAcc.set(stat, leagueCell);
        }
        leagueCell.sum += v;
        leagueCell.n += 1;
      }
    }
  }

  const leagueAvg: DefenseRatings["leagueAvg"] = {};
  for (const [stat, { sum, n }] of leagueAcc) {
    leagueAvg[stat] = { allowedPerGame: n > 0 ? sum / n : 0, gamesObserved: n };
  }
  const byTeam: DefenseRatings["byTeam"] = {};
  for (const [team, statMap] of teamAcc) {
    const inner: Record<string, { allowedPerGame: number; gamesObserved: number }> = {};
    for (const [stat, { sum, n }] of statMap) {
      inner[stat] = { allowedPerGame: n > 0 ? sum / n : 0, gamesObserved: n };
    }
    byTeam[team] = inner;
  }
  return { generatedAt: new Date().toISOString(), leagueAvg, byTeam };
}

/**
 * Per-stat defensive delta for a given opponent: how many units above (+)
 * or below (−) league average that team allows. `null` if we don't have
 * enough data for the team/stat. Combo stats (Pts+Rebs etc.) decompose
 * to atomic stats and sum.
 */
export function defensiveDelta(
  ratings: DefenseRatings,
  opponent: string,
  stat: string,
): { delta: number; sample: number } | null {
  const oppKey = opponent.toUpperCase();
  const components = decomposeStat(stat);
  let delta = 0;
  let minSample = Number.POSITIVE_INFINITY;
  for (const c of components) {
    const teamRow = ratings.byTeam[oppKey]?.[c];
    const leagueRow = ratings.leagueAvg[c];
    if (!teamRow || !leagueRow || teamRow.gamesObserved < 30) return null;
    delta += teamRow.allowedPerGame - leagueRow.allowedPerGame;
    minSample = Math.min(minSample, teamRow.gamesObserved);
  }
  return { delta, sample: minSample };
}

/** Combo stats (Pts+Rebs, PRA, …) decompose into a sum of atomic stats. */
function decomposeStat(stat: string): string[] {
  switch (stat) {
    case "Points":
    case "Rebounds":
    case "Assists":
    case "3-PT Made":
    case "Steals":
    case "Blocks":
      return [stat];
    case "Pts+Rebs":
      return ["Points", "Rebounds"];
    case "Pts+Asts":
      return ["Points", "Assists"];
    case "Rebs+Asts":
      return ["Rebounds", "Assists"];
    case "Pts+Rebs+Asts":
      return ["Points", "Rebounds", "Assists"];
    case "Stls+Blks":
      return ["Steals", "Blocks"];
    default:
      return [];
  }
}
