/**
 * Generalized ESPN live projection — the SAME fast path NBA/WNBA use (targeted
 * search + one gamelog request), parameterized by sport so any ESPN team sport
 * (NHL, NFL, college…) gets a REAL game-log projection instead of the implied
 * placeholder. This is the live-serving path; the adapters' `fetchPlayerRoster`
 * is a bulk TRAINING loader (e.g. tennis ingests ~520 weeks) and is NOT used here.
 *
 * A stat we can't map for a sport returns `available:false` → the no-mock gate
 * excludes that pick. So this only ever ADDS real coverage; it never fabricates.
 */
import { buildResult } from "@/lib/realProjections";
import type { ProjectionResult } from "@/lib/realProjections";
import type { Prop } from "@/lib/types";

interface EspnSearchItem {
  id: string;
  displayName: string;
  type: string;
  sport: string;
  league: string;
}

/** Resolve a player name → ESPN athlete id within a sport+league (one request). */
async function findAthleteId(
  name: string,
  sport: string,
  league: string,
  leagueMatch: "exact" | "sport" = "exact",
): Promise<string | null> {
  const cleaned = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(cleaned)}&limit=10&page=1&type=player`;
  try {
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = await res.json();
    const items: EspnSearchItem[] = data.items ?? [];
    const lower = cleaned.toLowerCase();
    // Soccer players span dozens of club leagues (Ronaldo searches as ksa.1) and
    // the gamelog is fetched league-agnostically (soccer/all), so "sport" matching
    // accepts any player in the sport instead of requiring an exact league hit.
    const leagueOk = (it: EspnSearchItem) => leagueMatch === "sport" || it.league === league;
    const exact = items.find(
      (it) => it.type === "player" && it.sport === sport && leagueOk(it) && it.displayName.toLowerCase() === lower,
    );
    if (exact) return exact.id;
    const inLeague = items.find((it) => it.type === "player" && it.sport === sport && leagueOk(it));
    return inLeague ? inLeague.id : null;
  } catch {
    return null;
  }
}

/** Fetch a player's gamelog, returning rows in CHRONOLOGICAL order (oldest →
 *  newest) so buildResult's recency weighting points at the right end. */
async function fetchGamelog(
  sport: string,
  league: string,
  athleteId: string,
): Promise<{ labels: string[]; rows: string[][] }> {
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/${sport}/${league}/athletes/${athleteId}/gamelog`;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return { labels: [], rows: [] };
    const data = await res.json();
    const labels: string[] = data.labels ?? data.names ?? [];
    const dateById = new Map<string, string>();
    const rawEvents = (data.events ?? {}) as Record<string, { gameDate?: string }>;
    for (const [id, ev] of Object.entries(rawEvents)) if (ev?.gameDate) dateById.set(id, ev.gameDate);
    const collected: { date: string; stats: string[] }[] = [];
    for (const st of data.seasonTypes ?? []) {
      for (const cat of st.categories ?? []) {
        for (const evt of cat.events ?? []) {
          if (Array.isArray(evt.stats)) {
            collected.push({ date: dateById.get(evt.eventId) ?? "", stats: evt.stats });
          }
        }
      }
    }
    // Sort oldest → newest; entries without a date keep their emission order.
    collected.sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : 0));
    return { labels, rows: collected.map((c) => c.stats) };
  } catch {
    return { labels: [], rows: [] };
  }
}

/** Pull a numeric value for `label` from one gamelog row, or null if the column
 *  isn't present (distinct from a real 0). Handles "8-18" made-attempt strings
 *  and "MM:SS" time strings. */
export function statByLabel(stats: string[], labels: string[], label: string): number | null {
  const i = labels.indexOf(label);
  if (i === -1) return null;
  const raw = (stats[i] ?? "").trim();
  if (raw === "") return null;
  if (raw.includes(":")) {
    const [m, s] = raw.split(":").map(Number);
    return Number.isFinite(m) ? m + (Number.isFinite(s) ? s / 60 : 0) : null;
  }
  if (raw.includes("-")) {
    const made = parseFloat(raw.split("-")[0]);
    return Number.isFinite(made) ? made : null;
  }
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export type LiveStatExtractor = (stats: string[], labels: string[]) => number | null;

export interface EspnLiveConfig {
  sport: string; // ESPN sport path segment, e.g. "hockey"
  league: string; // ESPN league segment, e.g. "nhl"
  modelVersion: string;
  /** PrizePicks statType → how to read it from a gamelog row. */
  stats: Record<string, LiveStatExtractor>;
  /** How to match the ESPN search hit. "exact" requires the player's league to
   *  equal `league` (default). "sport" matches any player in `sport` — used for
   *  soccer, whose players span dozens of club leagues and whose gamelog is read
   *  from the league-agnostic `soccer/all` endpoint. */
  leagueMatch?: "exact" | "sport";
}

/** One-stat convenience: read a single ESPN label. */
export const pick = (label: string): LiveStatExtractor => (s, l) => statByLabel(s, l, label);
/** Sum several ESPN labels (e.g. Power Play Points = PP goals + PP assists). */
export const sum = (...labels: string[]): LiveStatExtractor => (s, l) => {
  const vals = labels.map((lb) => statByLabel(s, l, lb));
  if (vals.every((v) => v === null)) return null; // none of the columns exist
  return vals.reduce<number>((a, v) => a + (v ?? 0), 0);
};

/**
 * Real game-log projection for any ESPN team sport. Returns `available:false`
 * (→ excluded by the no-mock gate, never faked) when the stat isn't mapped, the
 * player isn't found, or there aren't enough games.
 */
export async function espnLiveProjection(prop: Prop, cfg: EspnLiveConfig): Promise<ProjectionResult> {
  if (prop.isCombo) return { available: false, reason: "Combo prop — skipped" };
  const extractor = cfg.stats[prop.statType];
  if (!extractor) return { available: false, reason: `No live model for "${prop.statType}" in ${cfg.league.toUpperCase()}` };
  const id = await findAthleteId(prop.playerName, cfg.sport, cfg.league, cfg.leagueMatch ?? "exact");
  if (!id) return { available: false, reason: `Player "${prop.playerName}" not found in ESPN ${cfg.league.toUpperCase()}` };
  const { labels, rows } = await fetchGamelog(cfg.sport, cfg.league, id);
  if (rows.length === 0) return { available: false, reason: "ESPN returned no games for this player" };
  const values = rows
    .map((r) => extractor(r, labels))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  return buildResult(values, prop.line, `ESPN ${cfg.league.toUpperCase()} · ${prop.playerName}`, cfg.modelVersion);
}

// ── NHL (in-season; skater scoring labels are clean + unique) ──
// ESPN NHL skater gamelog labels: G A PTS +/- PIM S SPCT PPG PPA SHG SHA GWG TOI/G PROD
export const NHL_LIVE: EspnLiveConfig = {
  sport: "hockey",
  league: "nhl",
  modelVersion: "nhl-espn-live-v1",
  stats: {
    Points: pick("PTS"),
    Goals: pick("G"),
    Assists: pick("A"),
    SOG: pick("S"),
    Shots: pick("S"),
    "Plus/Minus": pick("+/-"),
    "Power Play Points": sum("PPG", "PPA"),
    // Hits / Blocked Shots / Faceoffs / Goalie stats are not in the skater
    // scoring gamelog → unmapped → excluded by the gate (never faked).
  },
};

export const nhlLiveProjection = (prop: Prop): Promise<ProjectionResult> => espnLiveProjection(prop, NHL_LIVE);

// ── Soccer / World Cup ──
// ESPN soccer gamelog is league-agnostic: soccer/all/athletes/{id}/gamelog.
// Field-player labels: G A SHOT SOG FC FA OF YC RC.  Goalkeeper labels: CS SV GA
// G A FC FA YC RC. A label absent for the player's role (e.g. SHOT for a keeper,
// SV for a striker) reads as null → unavailable → excluded by the no-mock gate.
// Recent CLUB form is the projection base — exactly "what a player did on their
// club before the World Cup". NOTE: ESPN's gamelog has NO passing/touch columns,
// so pass-attempt props cannot be priced and stay excluded (honest, not faked).
export const SOCCER_LIVE: EspnLiveConfig = {
  sport: "soccer",
  league: "all",
  modelVersion: "soccer-espn-live-v1",
  leagueMatch: "sport",
  stats: {
    Goals: pick("G"),
    Assists: pick("A"),
    Shots: pick("SHOT"),
    "Shots on Target": pick("SOG"),
    SOT: pick("SOG"),
    "Fouls Committed": pick("FC"),
    Fouls: pick("FC"),
    "Fouls Drawn": pick("FA"),
    "Fouls Suffered": pick("FA"),
    "Goals+Assists": sum("G", "A"),
    "Goal + Assist": sum("G", "A"),
    Offsides: pick("OF"),
    // Goalkeeper stats (present only on a keeper's gamelog).
    Saves: pick("SV"),
    "Goalie Saves": pick("SV"),
    "Goals Allowed": pick("GA"),
    "Clean Sheets": pick("CS"),
  },
};
export const soccerLiveProjection = (prop: Prop): Promise<ProjectionResult> => espnLiveProjection(prop, SOCCER_LIVE);

// ── NFL ──
// ESPN concatenates each player's stat BLOCKS into one labels row, and the
// blocks share labels (YDS/TD/AVG appear in passing, rushing AND receiving). So
// "Pass Yards" vs "Rush Yards" vs "Rec Yards" can't be read by label alone — we
// anchor on each block's leading label (passing=CMP, rushing=CAR, receiving=REC)
// and read the target label only WITHIN that block. A player missing a block
// (a WR has no passing) returns null for it → excluded, never faked.
function blockStat(anchor: string, label: string, otherAnchors: string[]): LiveStatExtractor {
  return (stats, labels) => {
    const start = labels.indexOf(anchor);
    if (start === -1) return null; // player has no such block
    let end = labels.length;
    for (const a of otherAnchors) {
      const i = labels.indexOf(a);
      if (i > start && i < end) end = i; // block ends at the next block's anchor
    }
    const idx = labels.indexOf(label, start);
    if (idx === -1 || idx >= end) return null;
    const raw = (stats[idx] ?? "").trim();
    if (raw === "" || raw === "-") return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
}

export const NFL_LIVE: EspnLiveConfig = {
  sport: "football",
  league: "nfl",
  modelVersion: "nfl-espn-live-v1",
  stats: {
    "Pass Yards": blockStat("CMP", "YDS", ["CAR", "REC"]),
    "Pass Completions": blockStat("CMP", "CMP", ["CAR", "REC"]),
    "Pass Attempts": blockStat("CMP", "ATT", ["CAR", "REC"]),
    "Pass TDs": blockStat("CMP", "TD", ["CAR", "REC"]),
    INT: blockStat("CMP", "INT", ["CAR", "REC"]),
    "Rush Yards": blockStat("CAR", "YDS", ["CMP", "REC"]),
    "Rush Attempts": blockStat("CAR", "CAR", ["CMP", "REC"]),
    "Rush TDs": blockStat("CAR", "TD", ["CMP", "REC"]),
    "Rec Yards": blockStat("REC", "YDS", ["CMP", "CAR"]),
    Receptions: blockStat("REC", "REC", ["CMP", "CAR"]),
    "Rec TDs": blockStat("REC", "TD", ["CMP", "CAR"]),
    "Rush+Rec TDs": (s, l) => {
      const rush = blockStat("CAR", "TD", ["CMP", "REC"])(s, l);
      const rec = blockStat("REC", "TD", ["CMP", "CAR"])(s, l);
      if (rush === null && rec === null) return null;
      return (rush ?? 0) + (rec ?? 0);
    },
    // "Sacks" (QB sacks-taken vs defensive sacks-made are ambiguous here) and
    // "Regular Season Games Started" (not a per-game stat) are deliberately
    // unmapped → excluded by the gate rather than risk a wrong real number.
  },
};

export const nflLiveProjection = (prop: Prop): Promise<ProjectionResult> => {
  // NFLSZN props are SEASON-LONG totals (e.g. 4000+ pass yards) — a per-game
  // gamelog model can't price them, so return unavailable rather than a
  // real-but-wrong number. The no-mock gate then excludes them.
  if ((prop.sport ?? "").toUpperCase() === "NFLSZN") {
    return Promise.resolve({ available: false, reason: "Season-long line — per-game model doesn't apply" });
  }
  return espnLiveProjection(prop, NFL_LIVE);
};
