import type { RawGame } from "@/lib/sports/types";

function n(g: RawGame, k: string): number | null {
  const v = g.stats[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : null;
  }
  return null;
}

const MAP: Record<string, string> = {
  "Pass Yards": "YDS-pass",
  "Pass Completions": "CMP",
  "Pass Attempts": "ATT",
  "Pass TDs": "TD-pass",
  "INT": "INT",
  "Receptions": "REC",
  "Rec Yards": "YDS-rec",
  "Rec TDs": "TD-rec",
  "Longest Reception": "LONG-rec",
  "Rush Yards": "YDS-rush",
  "Rush Attempts": "ATT-rush",
  "Rush TDs": "TD-rush",
  "Longest Rush": "LONG-rush",
  "Sacks": "SACK",
  "Tackles": "TKL",
  "Solo Tackles": "TKL-solo",
};

export function nflExtractStat(game: RawGame, statType: string): number | null {
  if (statType === "Rush+Rec Yards") {
    const r = n(game, "YDS-rush"), c = n(game, "YDS-rec");
    return r != null && c != null ? r + c : null;
  }
  if (statType === "Pass+Rush Yards") {
    const p = n(game, "YDS-pass"), r = n(game, "YDS-rush");
    return p != null && r != null ? p + r : null;
  }
  if (statType === "Rush+Rec TDs") {
    const r = n(game, "TD-rush"), c = n(game, "TD-rec");
    if (r == null && c == null) return null;
    return (r ?? 0) + (c ?? 0);
  }
  const k = MAP[statType];
  return k ? n(game, k) : null;
}
