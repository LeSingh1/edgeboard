import type { RawGame } from "@/lib/sports/types";

function n(g: RawGame, k: string): number | null {
  const v = g.stats[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}

export function mlbExtractStat(game: RawGame, statType: string): number | null {
  const role = game.stats.type;
  if (role === "hitter") {
    if (statType === "Hits") return n(game, "hits");
    if (statType === "Runs") return n(game, "runs");
    if (statType === "RBIs") return n(game, "rbi");
    if (statType === "Home Runs") return n(game, "homeRuns");
    if (statType === "Total Bases") return n(game, "totalBases");
    if (statType === "Stolen Bases") return n(game, "stolenBases");
    if (statType === "Walks") return n(game, "walks");
    if (statType === "Strikeouts") return n(game, "strikeouts");
    if (statType === "Hits+Runs+RBIs") {
      const h = n(game, "hits"), r = n(game, "runs"), rbi = n(game, "rbi");
      return h != null && r != null && rbi != null ? h + r + rbi : null;
    }
    if (statType === "Hitter Fantasy Score") {
      const h = n(game, "hits"), r = n(game, "runs"), rbi = n(game, "rbi"), hr = n(game, "homeRuns"), sb = n(game, "stolenBases"), bb = n(game, "walks");
      if ([h, r, rbi, hr, sb, bb].some(v => v == null)) return null;
      return 3 * h! + 2 * r! + 2 * rbi! + 4 * hr! + 5 * sb! + 1 * bb!;
    }
  }
  if (role === "pitcher") {
    if (statType === "Pitcher Strikeouts" || statType === "Ks") return n(game, "strikeouts");
    if (statType === "Pitcher Walks") return n(game, "walks");
    if (statType === "Pitcher Hits Allowed" || statType === "Hits Allowed") return n(game, "hits");
    if (statType === "Earned Runs") return n(game, "earnedRuns");
    if (statType === "Pitcher Outs") {
      const ip = n(game, "inningsPitched");
      if (ip == null) return null;
      const whole = Math.floor(ip), part = Math.round((ip - whole) * 10);
      return whole * 3 + part;
    }
    if (statType === "Ks + TB") {
      const ks = n(game, "strikeouts");
      return ks;
    }
  }
  return null;
}
