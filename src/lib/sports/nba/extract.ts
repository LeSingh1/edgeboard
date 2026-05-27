import type { RawGame } from "@/lib/sports/types";

const SIMPLE_MAP: Record<string, string> = {
  Points: "PTS",
  Rebounds: "REB",
  Assists: "AST",
  Steals: "STL",
  "Blocked Shots": "BLK",
  "3PTM": "3PM",
  "3PTA": "3PA",
  "FG Made": "FGM",
  "FG Attempted": "FGA",
  "FTM": "FTM",
  "FTA": "FTA",
  Turnovers: "TO",
};

function num(g: RawGame, key: string): number | null {
  const v = g.stats[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  return null;
}

export function nbaExtractStat(game: RawGame, statType: string): number | null {
  if (statType === "PRA") {
    const p = num(game, "PTS"), r = num(game, "REB"), a = num(game, "AST");
    return p != null && r != null && a != null ? p + r + a : null;
  }
  if (statType === "Pts+Rebs") { const p = num(game, "PTS"), r = num(game, "REB"); return p != null && r != null ? p + r : null; }
  if (statType === "Pts+Asts") { const p = num(game, "PTS"), a = num(game, "AST"); return p != null && a != null ? p + a : null; }
  if (statType === "Rebs+Asts") { const r = num(game, "REB"), a = num(game, "AST"); return r != null && a != null ? r + a : null; }
  if (statType === "Blks+Stls") { const b = num(game, "BLK"), s = num(game, "STL"); return b != null && s != null ? b + s : null; }
  if (statType === "Fantasy Score") {
    const p = num(game, "PTS"), r = num(game, "REB"), a = num(game, "AST"), s = num(game, "STL"), b = num(game, "BLK"), to = num(game, "TO");
    if ([p, r, a, s, b, to].some(v => v == null)) return null;
    return p! + 1.2 * r! + 1.5 * a! + 3 * s! + 3 * b! - 1 * to!;
  }
  const k = SIMPLE_MAP[statType];
  if (k) return num(game, k);
  return null;
}
