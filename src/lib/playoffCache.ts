/**
 * Process-level cache for the playoff warmup.
 *
 * Lives in module memory (single instance per Node worker, cleared on
 * restart). Populated by POST /api/playoff-warmup; read by /api/intel
 * (so when a prop for a cached player shows up, intel renders instantly
 * with the deeper signal set) and by Auto-Pilot (so the "playoff teams
 * only" filter knows which teams count).
 */

import type { PlayoffPlayer } from "@/lib/playoffRoster";
import type { NewsItem } from "@/lib/espnNews";
import type { IntelSignal } from "@/lib/heuristicIntel";

export interface PlayoffCacheEntry {
  player: PlayoffPlayer;
  news: NewsItem[];
  signals: IntelSignal[];
  warmedAt: string;
}

interface CacheState {
  teams: string[];
  byEspnId: Map<number, PlayoffCacheEntry>;
  byPlayerName: Map<string, PlayoffCacheEntry>;
  warmedAt: string | null;
  inProgress: boolean;
  progress: { done: number; total: number };
}

export const playoffCache: CacheState = {
  teams: [],
  byEspnId: new Map(),
  byPlayerName: new Map(),
  warmedAt: null,
  inProgress: false,
  progress: { done: 0, total: 0 },
};

/** Normalize a name so "DeMar DeRozan" ≈ "demar derozan" ≈ "Demar DeRozan". */
export function playoffNameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getPlayoffCacheEntry(name: string): PlayoffCacheEntry | undefined {
  return playoffCache.byPlayerName.get(playoffNameKey(name));
}

/** True iff the team abbreviation belongs to an alive playoff team. */
export function isPlayoffTeam(teamAbbr: string): boolean {
  if (!playoffCache.teams.length) return false;
  return playoffCache.teams.includes(teamAbbr.toUpperCase());
}

/** Public summary for the UI — no internal maps exposed. */
export function playoffCacheSummary() {
  return {
    teams: playoffCache.teams,
    playerCount: playoffCache.byEspnId.size,
    warmedAt: playoffCache.warmedAt,
    inProgress: playoffCache.inProgress,
    progress: playoffCache.progress,
  };
}
