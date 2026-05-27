import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
const MAP: Record<string, string> = {
  "Disposals": "D",
  "Kicks": "K",
  "Handballs": "HB",
  "Marks": "M",
  "Tackles": "T",
  "Goals": "G",
  "Behinds": "B",
};
export function aflExtractStat(game: RawGame, statType: string): number | null {
  if (statType === "Score Involvements") {
    const g = n(game, "G"), b = n(game, "B");
    return g != null && b != null ? g * 6 + b : null;  // standard AFL score formula
  }
  const k = MAP[statType];
  return k ? n(game, k) : null;
}
