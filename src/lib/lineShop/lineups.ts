/**
 * Builds the Line Betting slate: exactly `count` Power Plays of `legs` picks.
 *
 * Rules (from the spec):
 *   - Always `count` lineups (10) of `legs` picks (3) when the board allows it.
 *   - Every pick on the slate is unique: the same player + same stat never
 *     appears twice across ALL lineups (a player may repeat with a DIFFERENT stat).
 *   - PrizePicks entry rules inside a lineup: no player twice, ≥ 2 teams.
 *
 * Ordering: picks arrive ranked best-first; each lineup greedily takes the
 * best still-unused picks that satisfy the rules. Grouping strongest-with-
 * strongest maximizes total expected payout across the ten slips (for a fixed
 * pick set, Σ p1·p2·p3 is largest when sorted picks are chunked together).
 */

import type { LinePick } from "./engine";
import { breakevenPerLeg } from "./odds";
import { normPlayer } from "./stats";

export interface PowerPlay {
  rank: number;
  picks: LinePick[];
  /** Product of leg probabilities (legs treated as independent). */
  hitProb: number;
  multiplier: number;
  /** Expected profit per $1 entered: multiplier × hitProb − 1. */
  evPerDollar: number;
  /** Weakest data tier on the slip. */
  tier: LinePick["tier"];
  /** True when two legs come from the same game (correlated outcomes). */
  sameGame: boolean;
}

export interface Slate {
  lineups: PowerPlay[];
  requested: number;
  legs: number;
  multiplier: number;
  breakeven: number;
  uniquePicks: number;
  duplicateCheck: { repeatedKeys: string[] };
  shortfall?: string;
}

function playerKey(p: LinePick): string {
  return `${p.prop.sport.toUpperCase()}|${normPlayer(p.prop.playerName)}`;
}
function teamKey(p: LinePick): string {
  return p.prop.team ? p.prop.team.toUpperCase() : `?${p.id}`;
}
function gameKey(p: LinePick): string {
  const teams = [p.prop.team, p.prop.opponent].map((t) => (t || "?").toUpperCase()).sort();
  return `${p.prop.sport}|${teams.join("-")}|${p.prop.gameTime.slice(0, 10)}`;
}

/** Could `cand` join `lineup` (which will end with `legs` picks)? */
function fits(lineup: LinePick[], cand: LinePick, legs: number): boolean {
  if (lineup.some((l) => playerKey(l) === playerKey(cand))) return false;
  if (lineup.length === legs - 1) {
    const teams = new Set([...lineup, cand].map(teamKey));
    if (teams.size < 2) return false;
  }
  return true;
}

const TIER_ORDER: Record<LinePick["tier"], number> = { market: 0, model: 1, none: 2 };

export function buildSlate(
  ranked: LinePick[],
  opts: { count?: number; legs?: number; multiplier?: number } = {},
): Slate {
  const count = opts.count ?? 10;
  const legs = opts.legs ?? 3;
  const multiplier = opts.multiplier ?? 6;

  // Collapse the pool to one pick per uniqueKey (keep the best-ranked).
  const seen = new Set<string>();
  const pool: LinePick[] = [];
  for (const p of ranked) {
    if (seen.has(p.uniqueKey)) continue;
    seen.add(p.uniqueKey);
    pool.push(p);
  }

  const used = new Set<string>(); // uniqueKeys already on the slate
  const lineups: PowerPlay[] = [];

  for (let n = 0; n < count; n++) {
    const lineup: LinePick[] = [];
    for (const cand of pool) {
      if (lineup.length === legs) break;
      if (used.has(cand.uniqueKey)) continue;
      if (!fits(lineup, cand, legs)) continue;
      lineup.push(cand);
    }
    if (lineup.length < legs) break; // board exhausted
    for (const l of lineup) used.add(l.uniqueKey);
    const hitProb = lineup.reduce((a, l) => a * l.p, 1);
    const games = lineup.map(gameKey);
    lineups.push({
      rank: n + 1,
      picks: lineup,
      hitProb,
      multiplier,
      evPerDollar: multiplier * hitProb - 1,
      tier: lineup.reduce<LinePick["tier"]>((w, l) => (TIER_ORDER[l.tier] > TIER_ORDER[w] ? l.tier : w), "market"),
      sameGame: new Set(games).size < games.length,
    });
  }

  // Belt-and-braces audit: count any uniqueKey appearing twice on the slate.
  const counts = new Map<string, number>();
  for (const l of lineups) for (const p of l.picks) counts.set(p.uniqueKey, (counts.get(p.uniqueKey) ?? 0) + 1);
  const repeatedKeys = [...counts].filter(([, c]) => c > 1).map(([k]) => k);

  return {
    lineups,
    requested: count,
    legs,
    multiplier,
    breakeven: breakevenPerLeg(legs, multiplier),
    uniquePicks: counts.size,
    duplicateCheck: { repeatedKeys },
    shortfall:
      lineups.length < count
        ? `Only ${pool.length} distinct eligible picks on the board right now — built ${lineups.length} of ${count} lineups.`
        : undefined,
  };
}
