/**
 * Approximate playoff window per NBA season.
 *
 * The NBA schedule API doesn't tag gamelog entries as regular vs
 * postseason in a way we can read uniformly, so we approximate via
 * date: any game played between April 14 and June 30 of any season is
 * treated as a postseason game. This catches the play-in tournament
 * (mid-April), the four rounds (April → June), and the NBA Finals
 * (mid-June). Pre-April → regular season.
 *
 * Used by both `realProjections.ts` (live) and `scoreModel.ts`
 * (backtest) so the playoff-vs-regular split fires identically.
 */
export function isPlayoffDate(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  const month = d.getUTCMonth() + 1; // 1-12
  const day = d.getUTCDate();
  if (month === 4 && day >= 14) return true;
  if (month === 5) return true;
  if (month === 6 && day <= 30) return true;
  return false;
}
