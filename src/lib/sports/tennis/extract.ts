// src/lib/sports/tennis/extract.ts
import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
const MAP: Record<string, string> = {
  "Aces": "ACES",
  "Double Faults": "DF",
  "Break Points Won": "BPC",     // break points converted
  "Break Points Saved": "BPS",
  "Total Games": "GW",           // games won by this player
  "Total Games Won": "GW",
  "Sets Won": "SETS",
  "First Serve Percentage": "1ST-SVP",
};
export function tennisExtractStat(game: RawGame, statType: string): number | null {
  const k = MAP[statType];
  return k ? n(game, k) : null;
}
