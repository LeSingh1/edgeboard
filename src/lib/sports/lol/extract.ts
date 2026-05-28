import type { RawGame } from "@/lib/sports/types";

function n(g: RawGame, k: string): number | null {
  const v = g.stats[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}

export function lolExtractStat(game: RawGame, statType: string): number | null {
  switch (statType) {
    case "Kills": return n(game, "Kills");
    case "Deaths": return n(game, "Deaths");
    case "Assists": return n(game, "Assists");
    case "CS": return n(game, "CS");
    case "Kills+Assists": {
      const k = n(game, "Kills"); const a = n(game, "Assists");
      return k == null || a == null ? null : k + a;
    }
    default: return null;
  }
}
