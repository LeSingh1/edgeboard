/**
 * Live projection coverage — the single source of truth for "does a real model
 * actually price this prop, or is it just the flat PrizePicks-implied placeholder?"
 *
 * The board (`/api/props`) stamps EVERY prop with `impliedProbability(oddsType)`
 * (a flat 0.500 / 0.400 / 0.588) and `modelVersion: "implied-v1"` as a baseline so
 * the browse grid can render. A real game-log projection only exists for the
 * sports whose `project()` is actually inlined in `realProjections.ts`:
 *
 *   - NBA / WNBA  → ESPN basketball gamelog path
 *   - MLB         → MLB Stats API (`mlbProjection`)
 *   - NHL         → ESPN hockey gamelog path (`nhlLiveProjection`, skater stats)
 *   - NFL         → ESPN football gamelog path (`nflLiveProjection`, per-game;
 *                   NFLSZN season-long totals stay excluded)
 *
 * Every OTHER league on the board (World Cup, Badminton, CS2, Tennis, NFL, NHL,
 * PGA, LoL, …) returns "no real model / not yet inlined" and falls back to the
 * implied placeholder. Those numbers are NOT predictions — surfacing them as a
 * pick or an edge % is showing mock data. So picks may only ever be built from,
 * and a hit % may only ever be shown for, a live-projection league.
 *
 * Keep `LIVE_PROJECTION_BASE_LEAGUES` in sync with the adapters flagged
 * `hasLiveProjection: true` (asserted by a test) — when a sport's real projection
 * is genuinely inlined, add its base league here and the gate opens automatically.
 */

/** Base leagues with a real, inlined projection model today. */
export const LIVE_PROJECTION_BASE_LEAGUES = ["NBA", "WNBA", "MLB", "NHL", "NFL"] as const;

/** PrizePicks segment/variant suffixes that still resolve to the base model
 *  (e.g. NBA1Q, WNBA1H are scaled fractions of the full-game projection).
 *  Deliberately explicit so esports-style league names that merely start with a
 *  base (e.g. a hypothetical "NBA2K") are NOT treated as covered. */
const SEGMENT_SUFFIXES = ["", "1Q", "2Q", "3Q", "4Q", "1H", "2H", "1P", "2P", "3P", "LIVE"];

const COVERED = new Set<string>();
for (const base of LIVE_PROJECTION_BASE_LEAGUES) {
  for (const seg of SEGMENT_SUFFIXES) COVERED.add(`${base}${seg}`);
}

/**
 * True iff `sport` is a league a real projection model can price. Props from any
 * other league carry only the implied placeholder, so they must never drive a
 * pick or display a hit % — they'd be mock data.
 */
export function isLiveProjectionLeague(sport?: string | null): boolean {
  if (!sport) return false;
  return COVERED.has(sport.trim().toUpperCase());
}

/**
 * Sports that are explicitly prohibited from appearing in any generated slip,
 * regardless of their modelVersion. Listed here when the calibration data is
 * too sparse or unreliable to trust — NPB has only a `real-outcomes-v1`
 * artifact (10 training samples, 1 calibration bucket) and no inlined
 * projection path, so its probability numbers are not real predictions.
 *
 * A sport stays on this list until it has a proper training-v2 artifact AND
 * an inlined `project()` function in `realProjections.ts`. It must also be
 * added to `LIVE_PROJECTION_BASE_LEAGUES` above to pass the gate.
 */
export const BLOCKED_SPORTS = new Set(["NPB"]);

/** True iff `sport` is on the hard no-bet list. */
export function isBlockedSport(sport?: string | null): boolean {
  if (!sport) return false;
  return BLOCKED_SPORTS.has(sport.trim().toUpperCase());
}
