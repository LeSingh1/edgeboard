/**
 * Closing-Line Value (CLV).
 *
 * CLV is the single most trustworthy signal that a betting model has a real
 * edge. The idea: record the line WHEN we make a pick, then record the line at
 * CLOSE (the last line before the prop locks). If the line consistently moves
 * in our favor after we pick, we are systematically beating the market, which
 * is the only robust proof of edge over a large sample. It replaces synthetic
 * held-out accuracy (which never touches a real market) with a real-world test.
 *
 * This module is pure: it computes CLV from recorded picks. Persistence (the
 * clvLog.json ledger) and capture live elsewhere so this stays unit-testable.
 *
 * Sign convention (the part that is easy to get wrong, so it is tested):
 *   - A "more" (over) pick wants the line LOW. If the close is below where we
 *     picked, the market moved our way, so positive CLV = lineAtPick - lineAtClose.
 *   - A "less" (under) pick wants the line HIGH. If the close is above where we
 *     picked, the market moved our way, so positive CLV = lineAtClose - lineAtPick.
 *   - beatClose is true when clvPoints > 0.
 */

export type PickSide = "more" | "less";

/** One recommended pick, captured at pick time and updated at close. */
export interface RecordedPick {
  id: string;
  sport: string;
  player: string;
  statType: string;
  side: PickSide;
  /** Line on the board when we recommended it. */
  lineAtPick: number;
  /** Our calibrated probability for the chosen side at pick time. */
  pAtPick: number;
  /** ISO timestamp when we recorded the pick. */
  pickedAt: string;
  /** Line at close (last line before lock). Absent until the line settles. */
  lineAtClose?: number;
  /** ISO timestamp when the close was captured. */
  closedAt?: string;
}

export interface ClvResult {
  /** Points the line moved in our favor (negative = it moved against us). */
  clvPoints: number;
  beatClose: boolean;
}

/**
 * Compute CLV for one pick. Returns null when the close has not been captured
 * yet (no lineAtClose), so callers can cleanly separate "tracked" from "closed".
 */
export function computeClv(pick: RecordedPick): ClvResult | null {
  if (pick.lineAtClose == null || !Number.isFinite(pick.lineAtClose)) return null;
  const delta =
    pick.side === "more"
      ? pick.lineAtPick - pick.lineAtClose // over wants the line to drop
      : pick.lineAtClose - pick.lineAtPick; // under wants the line to rise
  const clvPoints = Math.round(delta * 100) / 100;
  return { clvPoints, beatClose: clvPoints > 0 };
}

export interface ClvSummary {
  /** Picks recorded (whether or not the close has been captured). */
  tracked: number;
  /** Picks with a captured close (the ones CLV can be computed for). */
  closed: number;
  /** How many of the closed picks beat the close (positive CLV). */
  beatClose: number;
  /** Fraction of closed picks that beat the close (0..1), or null if none. */
  beatRate: number | null;
  /** Average CLV in points across closed picks, or null if none. */
  avgClvPoints: number | null;
  /** Per-sport beat counts, for surfacing which leagues actually have edge. */
  bySport: Record<string, { closed: number; beatClose: number }>;
}

/**
 * Aggregate CLV across a ledger of recorded picks. A beatRate meaningfully and
 * persistently above 50% is the honest signal of real edge; at or below 50%
 * means the picks are not beating the market, no matter what synthetic accuracy
 * says.
 */
export function summarizeClv(picks: RecordedPick[]): ClvSummary {
  let closed = 0;
  let beat = 0;
  let pointsSum = 0;
  const bySport: Record<string, { closed: number; beatClose: number }> = {};

  for (const p of picks) {
    const clv = computeClv(p);
    if (!clv) continue;
    closed++;
    pointsSum += clv.clvPoints;
    const bucket = (bySport[p.sport] ??= { closed: 0, beatClose: 0 });
    bucket.closed++;
    if (clv.beatClose) {
      beat++;
      bucket.beatClose++;
    }
  }

  return {
    tracked: picks.length,
    closed,
    beatClose: beat,
    beatRate: closed > 0 ? beat / closed : null,
    avgClvPoints: closed > 0 ? Math.round((pointsSum / closed) * 100) / 100 : null,
    bySport,
  };
}
