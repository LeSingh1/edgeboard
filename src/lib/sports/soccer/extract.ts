// src/lib/sports/soccer/extract.ts
import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
export function soccerExtractStat(game: RawGame, statType: string): number | null {
  const role = game.stats.type;
  if (role === "field") {
    if (statType === "Goals") return n(game, "G");
    if (statType === "Assists") return n(game, "A");
    // ESPN's soccer summary uses SHOT / SOG (not SH / ST) — the old keys never
    // matched, which is why Shots & SOT were never trained for soccer.
    if (statType === "Shots") return n(game, "SHOT");
    if (statType === "Shots on Target" || statType === "SOT") return n(game, "SOG");
    if (statType === "Fouls Committed" || statType === "Fouls") return n(game, "FC");
    if (statType === "Fouls Suffered") return n(game, "FA");
    if (statType === "Goals+Assists" || statType === "Goal + Assist") {
      const g = n(game, "G"), a = n(game, "A");
      return g != null && a != null ? g + a : null;
    }
  }
  if (role === "goalkeeper") {
    if (statType === "Saves" || statType === "Goalie Saves") return n(game, "SV");
    if (statType === "Goals Allowed") return n(game, "GA");
  }
  return null;
}
