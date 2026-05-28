import type { RawGame } from "@/lib/sports/types";

function n(g: RawGame, k: string): number | null {
  const v = g.stats[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}

export function npbExtractStat(game: RawGame, statType: string): number | null {
  switch (statType) {
    case "Hits": return n(game, "H");
    case "Runs": return n(game, "R");
    case "RBIs": return n(game, "RBI");
    case "Stolen Bases": return n(game, "SB");
    case "At Bats": return n(game, "AB");
    case "Hits+Runs+RBIs": {
      const h = n(game, "H"), r = n(game, "R"), rbi = n(game, "RBI");
      return h == null || r == null || rbi == null ? null : h + r + rbi;
    }
    default: return null;
  }
}
