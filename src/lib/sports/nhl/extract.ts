// src/lib/sports/nhl/extract.ts
import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
export function nhlExtractStat(game: RawGame, statType: string): number | null {
  const role = game.stats.type;
  if (role === "skater") {
    if (statType === "Goals") return n(game, "G");
    if (statType === "Assists") return n(game, "A");
    if (statType === "Shots" || statType === "SOG") return n(game, "SOG");
    if (statType === "Points") { const g = n(game, "G"), a = n(game, "A"); return g != null && a != null ? g + a : null; }
    if (statType === "Hits") return n(game, "HITS");
    if (statType === "Blocks") return n(game, "BLK");
  }
  if (role === "goalie") {
    if (statType === "Goalie Saves" || statType === "Saves") return n(game, "SV");
    if (statType === "Goals Allowed") return n(game, "GA");
    if (statType === "Save Percentage") {
      const sv = n(game, "SV"), sa = n(game, "SA");
      return sv != null && sa != null && sa > 0 ? sv / sa : null;
    }
  }
  return null;
}
