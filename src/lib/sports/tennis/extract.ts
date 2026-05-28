// src/lib/sports/tennis/extract.ts
import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
export function tennisExtractStat(game: RawGame, statType: string): number | null {
  if (statType === "Sets Won") return n(game, "SETS");
  if (statType === "Total Games" || statType === "Total Games Won") return n(game, "GW");
  return null;
}
