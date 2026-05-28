import type { RawGame } from "@/lib/sports/types";

const SIMPLE_MAP: Record<string, string> = {
  Points: "PTS",
  Rebounds: "REB",
  Assists: "AST",
  Steals: "STL",
  "Blocked Shots": "BLK",
  Turnovers: "TO",
  "Personal Fouls": "PF",
};

function num(g: RawGame, key: string): number | null {
  const v = g.stats[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** ESPN gamelog gives shot stats as "M-A" strings like "3-8". Parse made/attempted. */
function parseMadeAtt(g: RawGame, key: string): { made: number; att: number } | null {
  const v = g.stats[key];
  if (typeof v === "number") return null;
  if (typeof v !== "string") return null;
  const m = /^(\d+)-(\d+)$/.exec(v.trim());
  if (!m) return null;
  return { made: parseInt(m[1], 10), att: parseInt(m[2], 10) };
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
  // ESPN gamelog packs shot stats as "M-A" strings under FG / 3PT / FT.
  if (statType === "FG Made") { const x = parseMadeAtt(game, "FG"); return x?.made ?? null; }
  if (statType === "FG Attempted") { const x = parseMadeAtt(game, "FG"); return x?.att ?? null; }
  if (statType === "3PTM") { const x = parseMadeAtt(game, "3PT"); return x?.made ?? null; }
  if (statType === "3PTA") { const x = parseMadeAtt(game, "3PT"); return x?.att ?? null; }
  if (statType === "FTM") { const x = parseMadeAtt(game, "FT"); return x?.made ?? null; }
  if (statType === "FTA") { const x = parseMadeAtt(game, "FT"); return x?.att ?? null; }
  if (statType === "2-PT Made") {
    const fg = parseMadeAtt(game, "FG"), tp = parseMadeAtt(game, "3PT");
    if (!fg || !tp) return null;
    return fg.made - tp.made;
  }
  if (statType === "2-PT Att") {
    const fg = parseMadeAtt(game, "FG"), tp = parseMadeAtt(game, "3PT");
    if (!fg || !tp) return null;
    return fg.att - tp.att;
  }
  if (statType === "Double-Double") {
    const cats = [num(game, "PTS"), num(game, "REB"), num(game, "AST"), num(game, "STL"), num(game, "BLK")];
    if (cats.some(v => v == null)) return null;
    const tens = cats.filter(v => (v as number) >= 10).length;
    return tens >= 2 ? 1 : 0;
  }
  const k = SIMPLE_MAP[statType];
  if (k) return num(game, k);
  return null;
}
