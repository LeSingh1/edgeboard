import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
const MAP: Record<string, string> = {
  "Strokes": "STROKES",
  "Birdies": "BIRDIES",
  "Pars": "PARS",
  "Bogeys": "BOGEYS",
  "Eagles": "EAGLES",
  "Fairways Hit": "FH",
  "Greens in Regulation": "GIR",
  "Putts": "PUTTS",
};
export function pgaExtractStat(game: RawGame, statType: string): number | null {
  if (statType === "Birdies Or Better") {
    const b = n(game, "BIRDIES"), e = n(game, "EAGLES");
    if (b == null && e == null) return null;
    return (b ?? 0) + (e ?? 0);
  }
  const k = MAP[statType];
  return k ? n(game, k) : null;
}
