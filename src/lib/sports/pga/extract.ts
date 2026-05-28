import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
export function pgaExtractStat(game: RawGame, statType: string): number | null {
  if (statType === "Strokes") return n(game, "STROKES");
  if (statType === "Birdies") return n(game, "BIRDIES");
  if (statType === "Pars") return n(game, "PARS");
  if (statType === "Bogeys") return n(game, "BOGEYS");
  if (statType === "Eagles") return n(game, "EAGLES");
  if (statType === "Birdies Or Better" || statType === "Birdies or Better Matchup") return n(game, "BIRDIES_OR_BETTER");
  if (statType === "Fairways Hit") return n(game, "FH");
  if (statType === "Greens in Regulation" || statType === "Greens In Regulation") return n(game, "GIR");
  if (statType === "Putts") return n(game, "PUTTS");
  return null;
}
