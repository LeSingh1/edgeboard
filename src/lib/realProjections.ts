/**
 * Real player-stat projection — replaces PrizePicks-implied probabilities
 * with one computed from actual game logs.
 *
 *   - MLB:  MLB Stats API (free, no auth)
 *   - NBA:  BallDontLie API (requires user-provided free key, stored in Settings)
 *   - others: not yet — fall back to implied
 *
 * Output is the same shape as the implied model: { pMore, pLess, projection, source }.
 */

import type { Prop } from "@/lib/types";

export interface RealProjection {
  pMore: number;
  pLess: number;
  projection: number;
  sigma: number;
  sampleSize: number;
  recent: number[];           // last few raw values for the chart / explainer
  source: string;             // e.g. "MLB Stats API · last 49 games"
  modelVersion: string;       // e.g. "mlb-rolling-v1"
}

export interface UnavailableProjection {
  available: false;
  reason: string;
}

export type ProjectionResult = (RealProjection & { available: true }) | UnavailableProjection;

// ════════════════════════════════════════════════════════════════════
// Statistics helpers
// ════════════════════════════════════════════════════════════════════

function meanStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** Abramowitz-Stegun approximation of normal CDF. */
function cdfNormal(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function r3(n: number) {
  return Math.round(n * 1000) / 1000;
}

function buildResult(values: number[], line: number, source: string, modelVersion: string): ProjectionResult {
  if (values.length < 5) {
    return { available: false, reason: `Only ${values.length} games — need at least 5` };
  }
  const { mean, std } = meanStd(values);
  // Floor sigma so we don't divide by ~0 for very tight stats
  const sigma = Math.max(std, mean * 0.15, 0.5);
  const z = (line - mean) / sigma;
  const pMore = 1 - cdfNormal(z);
  return {
    available: true,
    pMore: r3(Math.max(0.02, Math.min(0.98, pMore))),
    pLess: r3(1 - Math.max(0.02, Math.min(0.98, pMore))),
    projection: r3(mean),
    sigma: r3(sigma),
    sampleSize: values.length,
    recent: values.slice(-10),
    source: `${source} · last ${values.length} games`,
    modelVersion,
  };
}

// ════════════════════════════════════════════════════════════════════
// MLB Stats API (statsapi.mlb.com) — no auth
// ════════════════════════════════════════════════════════════════════

interface MlbStatGame {
  date?: string;
  stat: Record<string, number | string>;
}

type MlbExtractor = (s: Record<string, number | string>) => number | null;

const MLB_HITTING_STATS: Record<string, MlbExtractor> = {
  "Hits":              (s) => num(s.hits),
  "Hit":               (s) => num(s.hits),
  "Total Bases":       (s) => num(s.totalBases),
  "TB":                (s) => num(s.totalBases),
  "Walks":             (s) => num(s.baseOnBalls),
  "Walk":              (s) => num(s.baseOnBalls),
  "BBs":               (s) => num(s.baseOnBalls),
  "Home Runs":         (s) => num(s.homeRuns),
  "HR":                (s) => num(s.homeRuns),
  "HRs":               (s) => num(s.homeRuns),
  "Hitter Strikeouts": (s) => num(s.strikeOuts),
  "Hitter Ks":         (s) => num(s.strikeOuts),
  "Runs":              (s) => num(s.runs),
  "Runs Scored":       (s) => num(s.runs),
  "RBIs":              (s) => num(s.rbi),
  "RBI":               (s) => num(s.rbi),
  "Stolen Bases":      (s) => num(s.stolenBases),
  "Singles":           (s) => Math.max(0, num(s.hits) - num(s.doubles) - num(s.triples) - num(s.homeRuns)),
  "Doubles":           (s) => num(s.doubles),
  "Triples":           (s) => num(s.triples),
  "Extra Base Hits":   (s) => num(s.doubles) + num(s.triples) + num(s.homeRuns),
  "Hits+Runs+RBIs":    (s) => num(s.hits) + num(s.runs) + num(s.rbi),
  "HRR":               (s) => num(s.hits) + num(s.runs) + num(s.rbi),
  "Fantasy Score":     (s) =>
    num(s.hits) * 3 +
    num(s.totalBases) * 2 +
    num(s.runs) * 2 +
    num(s.rbi) * 2 +
    num(s.baseOnBalls) * 2 -
    num(s.strikeOuts), // PrizePicks Fantasy Score approximation
  "Hitter FS":         (s) =>
    num(s.hits) * 3 + num(s.totalBases) * 2 + num(s.runs) * 2 + num(s.rbi) * 2 + num(s.baseOnBalls) * 2 - num(s.strikeOuts),
};

const MLB_PITCHING_STATS: Record<string, MlbExtractor> = {
  "Pitcher Strikeouts": (s) => num(s.strikeOuts),
  "Pitcher Ks":         (s) => num(s.strikeOuts),
  "Ks":                 (s) => num(s.strikeOuts),
  "Strikeouts":         (s) => num(s.strikeOuts),
  "Pitching Outs":      (s) => num(s.outs),
  "Outs":               (s) => num(s.outs),
  "Earned Runs":        (s) => num(s.earnedRuns),
  "Earned Runs Allowed": (s) => num(s.earnedRuns),
  "Hits Allowed":       (s) => num(s.hits),
  "Walks Allowed":      (s) => num(s.baseOnBalls),
  "Pitches Thrown":     (s) => num(s.numberOfPitches ?? s.pitchesThrown),
  "Pitching FS":        (s) =>
    num(s.outs) * 1 + num(s.strikeOuts) * 3 - num(s.earnedRuns) * 3 - num(s.baseOnBalls) - num(s.hits),
};

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const PITCHER_STAT_HINTS = ["pitcher", "pitching", "Ks", "Strikeout", "Outs", "Innings", "Earned Runs"];

function looksLikePitcherStat(statType: string): boolean {
  const s = statType.toLowerCase();
  return PITCHER_STAT_HINTS.some((h) => s.includes(h.toLowerCase()));
}

async function mlbSearchPlayer(name: string): Promise<{ id: number; name: string } | null> {
  // MLB API doesn't handle "First + Last" combos. Strip qualifiers.
  const cleaned = name.replace(/\s+\+.*$/, "").trim();
  const url = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(cleaned)}&active=true`;
  try {
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.people?.[0];
    if (!p) return null;
    return { id: p.id, name: p.fullName };
  } catch {
    return null;
  }
}

async function mlbGameLog(playerId: number, group: "hitting" | "pitching"): Promise<MlbStatGame[]> {
  const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=2026&group=${group}`;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.stats?.[0]?.splits ?? [];
  } catch {
    return [];
  }
}

export async function mlbProjection(prop: Prop): Promise<ProjectionResult> {
  if (prop.isCombo) return { available: false, reason: "Combo prop — skipped" };

  const player = await mlbSearchPlayer(prop.playerName);
  if (!player) return { available: false, reason: `Player "${prop.playerName}" not found in MLB API` };

  const usePitcher = looksLikePitcherStat(prop.statType);
  const extractor =
    (usePitcher ? MLB_PITCHING_STATS[prop.statType] : MLB_HITTING_STATS[prop.statType]) ??
    MLB_HITTING_STATS[prop.statType] ??
    MLB_PITCHING_STATS[prop.statType];
  if (!extractor) {
    return { available: false, reason: `No mapping for stat type "${prop.statType}"` };
  }

  const games = await mlbGameLog(player.id, usePitcher ? "pitching" : "hitting");
  const values = games
    .map((g) => extractor(g.stat))
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));

  return buildResult(values, prop.line, `MLB Stats API · ${player.name}`, "mlb-rolling-v1");
}

// ════════════════════════════════════════════════════════════════════
// NBA / WNBA — ESPN public gamelog API (free, no auth)
// ════════════════════════════════════════════════════════════════════
// Endpoints:
//   /search  → resolve player name → ESPN athlete ID
//   /sports/basketball/{nba|wnba}/athletes/{id}/gamelog → full season log
//
// Stats array layout (from response.labels):
//   ['MIN', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'REB', 'AST', 'BLK', 'STL', 'PF', 'TO', 'PTS']
// "FG", "3PT", "FT" are "made-attempted" strings (e.g. "8-18") — we take the made portion.

function extractByLabel(stats: string[], labels: string[], label: string): number {
  const i = labels.indexOf(label);
  if (i === -1) return 0;
  const raw = stats[i] ?? "";
  if (raw.includes("-")) return parseFloat(raw.split("-")[0]) || 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

type EspnStatExtractor = (stats: string[], labels: string[]) => number;

const ESPN_BASKETBALL_STATS: Record<string, EspnStatExtractor> = {
  "Points":          (s, l) => extractByLabel(s, l, "PTS"),
  "Pts":             (s, l) => extractByLabel(s, l, "PTS"),
  "Rebounds":        (s, l) => extractByLabel(s, l, "REB"),
  "Reb":             (s, l) => extractByLabel(s, l, "REB"),
  "Assists":         (s, l) => extractByLabel(s, l, "AST"),
  "Ast":             (s, l) => extractByLabel(s, l, "AST"),
  "3PT Made":        (s, l) => extractByLabel(s, l, "3PT"),
  "3-PT Made":       (s, l) => extractByLabel(s, l, "3PT"),
  "Threes":          (s, l) => extractByLabel(s, l, "3PT"),
  "Steals":          (s, l) => extractByLabel(s, l, "STL"),
  "Blocks":          (s, l) => extractByLabel(s, l, "BLK"),
  "Turnovers":       (s, l) => extractByLabel(s, l, "TO"),
  "FG Made":         (s, l) => extractByLabel(s, l, "FG"),
  "FT Made":         (s, l) => extractByLabel(s, l, "FT"),
  "FTM":             (s, l) => extractByLabel(s, l, "FT"),
  "Free Throws Made": (s, l) => extractByLabel(s, l, "FT"),
  "Minutes":         (s, l) => extractByLabel(s, l, "MIN"),
  "Pts+Rebs":        (s, l) => extractByLabel(s, l, "PTS") + extractByLabel(s, l, "REB"),
  "Pts+Asts":        (s, l) => extractByLabel(s, l, "PTS") + extractByLabel(s, l, "AST"),
  "Pts+Rebs+Asts":   (s, l) => extractByLabel(s, l, "PTS") + extractByLabel(s, l, "REB") + extractByLabel(s, l, "AST"),
  "PRA":             (s, l) => extractByLabel(s, l, "PTS") + extractByLabel(s, l, "REB") + extractByLabel(s, l, "AST"),
  "Rebs+Asts":       (s, l) => extractByLabel(s, l, "REB") + extractByLabel(s, l, "AST"),
  "Stocks":          (s, l) => extractByLabel(s, l, "STL") + extractByLabel(s, l, "BLK"),
  "Defensive Rebounds": (s, l) => extractByLabel(s, l, "REB"), // ESPN doesn't split DREB/OREB in basic log
  "Fantasy Score":   (s, l) =>
    extractByLabel(s, l, "PTS") +
    extractByLabel(s, l, "REB") * 1.2 +
    extractByLabel(s, l, "AST") * 1.5 +
    extractByLabel(s, l, "STL") * 3 +
    extractByLabel(s, l, "BLK") * 3 -
    extractByLabel(s, l, "TO"),
};

interface EspnSearchItem {
  id: string;
  displayName: string;
  type: string;
  sport: string;
  league: string;
}

interface EspnGamelogEvent {
  eventId: string;
  stats: string[];
}

async function espnFindAthleteId(
  playerName: string,
  league: "nba" | "wnba",
): Promise<number | null> {
  // Strip diacritics so "Jokić" → "Jokic" — ESPN stores plain ASCII
  const cleaned = playerName.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(cleaned)}&limit=10&page=1&type=player`;
  try {
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = await res.json();
    const items: EspnSearchItem[] = data.items ?? [];
    const lowerName = cleaned.toLowerCase();
    // Prefer exact display-name match in the right league
    const exact = items.find(
      (it) =>
        it.type === "player" &&
        it.sport === "basketball" &&
        it.league === league &&
        it.displayName.toLowerCase() === lowerName,
    );
    if (exact) return Number(exact.id);
    // Fall back to first matching league
    const inLeague = items.find(
      (it) => it.type === "player" && it.sport === "basketball" && it.league === league,
    );
    return inLeague ? Number(inLeague.id) : null;
  } catch {
    return null;
  }
}

async function espnGameLog(
  athleteId: number,
  league: "nba" | "wnba",
): Promise<{ labels: string[]; events: EspnGamelogEvent[] }> {
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/${league}/athletes/${athleteId}/gamelog`;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return { labels: [], events: [] };
    const data = await res.json();
    const labels: string[] = data.labels ?? [];
    const events: EspnGamelogEvent[] = [];
    for (const st of data.seasonTypes ?? []) {
      for (const cat of st.categories ?? []) {
        for (const evt of cat.events ?? []) {
          if (evt.stats && Array.isArray(evt.stats)) {
            events.push({ eventId: evt.eventId, stats: evt.stats });
          }
        }
      }
    }
    return { labels, events };
  } catch {
    return { labels: [], events: [] };
  }
}

export async function nbaProjection(prop: Prop): Promise<ProjectionResult> {
  if (prop.isCombo) return { available: false, reason: "Combo prop — skipped" };

  const extractor = ESPN_BASKETBALL_STATS[prop.statType];
  if (!extractor) {
    return { available: false, reason: `No mapping for stat type "${prop.statType}"` };
  }

  const sport = prop.sport.toUpperCase();
  const league: "nba" | "wnba" = sport.startsWith("WNBA") ? "wnba" : "nba";

  const athleteId = await espnFindAthleteId(prop.playerName, league);
  if (!athleteId) {
    return { available: false, reason: `Player "${prop.playerName}" not found in ESPN ${league.toUpperCase()}` };
  }

  const { labels, events } = await espnGameLog(athleteId, league);
  if (events.length === 0) {
    return { available: false, reason: "ESPN returned no games for this player" };
  }

  const values = events
    .map((e) => extractor(e.stats, labels))
    .filter((v) => Number.isFinite(v) && v >= 0);

  return buildResult(values, prop.line, `ESPN ${league.toUpperCase()} · ${prop.playerName}`, `${league}-espn-v1`);
}

// ════════════════════════════════════════════════════════════════════
// Router — pick the right source for a prop
// ════════════════════════════════════════════════════════════════════

export async function projectionFor(prop: Prop): Promise<ProjectionResult> {
  const sport = prop.sport.toUpperCase();

  // Strict matching: only full-game leagues get the real-projection treatment.
  // Period/quarter/inning variants (NBA4Q, WNBA2H, NHL3P, MLBLIVE, etc.) use
  // PrizePicks-implied as fallback — a full-season game-log average would
  // over-project a quarter line by ~4×.
  if (sport === "MLB") {
    return mlbProjection(prop);
  }
  if (sport === "NBA" || sport === "WNBA") {
    return nbaProjection(prop);
  }
  return {
    available: false,
    reason: `No full-game real model for ${prop.sport} — using PrizePicks implied (period/quarter props always fall back to avoid distorted full-game projections)`,
  };
}
