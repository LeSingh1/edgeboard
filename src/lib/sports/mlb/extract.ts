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
    if (statType === "Total Bases" || statType === "TB") return n(game, "totalBases");
    if (statType === "Stolen Bases" || statType === "SB") return n(game, "stolenBases");
    if (statType === "Walks") return n(game, "walks");
    if (statType === "Strikeouts" || statType === "Hitter Ks") return n(game, "strikeouts");
    if (statType === "Doubles") return n(game, "doubles");
    if (statType === "Singles") {
      const h = n(game, "hits"), d = n(game, "doubles"), t = n(game, "triples"), hr = n(game, "homeRuns");
      if (h == null) return null;
      return h - (d ?? 0) - (t ?? 0) - (hr ?? 0);
    }
    if (statType === "Hits+Runs+RBIs") {
      const h = n(game, "hits"), r = n(game, "runs"), rbi = n(game, "rbi");
      return h != null && r != null && rbi != null ? h + r + rbi : null;
    }
    if (statType === "Hitter Fantasy Score" || statType === "Hitter FS") {
      const h = n(game, "hits"), r = n(game, "runs"), rbi = n(game, "rbi"), hr = n(game, "homeRuns"), sb = n(game, "stolenBases"), bb = n(game, "walks");
      if ([h, r, rbi, hr, sb, bb].some(v => v == null)) return null;
      return 3 * h! + 2 * r! + 2 * rbi! + 4 * hr! + 5 * sb! + 1 * bb!;
    }
  }
  if (role === "pitcher") {
    if (statType === "Pitcher Strikeouts" || statType === "Ks") return n(game, "strikeouts");
    if (statType === "Pitcher Walks") return n(game, "walks");
    if (statType === "Pitcher Hits Allowed" || statType === "Hits Allowed") return n(game, "hits");
    if (statType === "Earned Runs" || statType === "Earned Runs Allowed") return n(game, "earnedRuns");
    if (statType === "Pitches Thrown") return n(game, "numberOfPitches") ?? n(game, "pitchesThrown") ?? n(game, "pitchCount");
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
    if (statType === "Pitcher FS") {
      // Standard pitcher fantasy: 3*IP_outs + 3*K - 3*ER - BB - H
      const ip = n(game, "inningsPitched"), ks = n(game, "strikeouts"), er = n(game, "earnedRuns"), bb = n(game, "walks"), h = n(game, "hits");
      if ([ip, ks, er, bb, h].some(v => v == null)) return null;
      const whole = Math.floor(ip!), part = Math.round((ip! - whole) * 10);
      const outs = whole * 3 + part;
      return outs + 3 * ks! - 3 * er! - bb! - h!;
    }
  }
  return null;
}
