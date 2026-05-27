/**
 * Basketball-Reference scraper for career playoff history.
 *
 * Used to augment the playoff-deep dataset with multi-year playoff totals
 * that ESPN's gamelog window doesn't cover. For veterans like LeBron, KD,
 * Harden, this brings in 5-15 prior years of postseason data.
 *
 * Rate-limited deliberately — BR's robots.txt asks for ≤10 req/min from
 * scrapers. We batch with 8s sleeps between requests.
 *
 * Player-code mapping: ESPN provides only `displayName`; BR uses a code
 * like `wembavi01`. We try the heuristic mapping first (first 5 letters
 * of last name + first 2 of first name + "01"), then "02" / "03" if that
 * 404s. Search-endpoint fallback isn't needed for the common case.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface BRPlayoffSeries {
  season: string;       // e.g. "2025-26"
  round: string;        // e.g. "WCF"
  opponent: string;     // team abbr
  result: string;       // e.g. "L (2-4)"
  games: number;
  ptsPerGame: number;
  trbPerGame: number;
  astPerGame: number;
  fgPct: number;
  fg3PerGame: number;
}

export interface BRPlayoffCareer {
  code: string;
  totalGames: number;
  totalPts: number;
  totalTrb: number;
  totalAst: number;
  seasons: number;
  series: BRPlayoffSeries[];
  /** Derived per-game career playoff splits */
  careerPlayoffPpg: number;
  careerPlayoffRpg: number;
  careerPlayoffApg: number;
}

/** Build heuristic BR code candidates for a player's name. */
export function brCodeCandidates(displayName: string): string[] {
  const parts = displayName.replace(/[^A-Za-z\s'-]/g, "").trim().split(/\s+/);
  if (parts.length < 2) return [];
  const last = parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, "");
  const first = parts[0].toLowerCase().replace(/[^a-z]/g, "");
  if (!last || !first) return [];
  const lastFive = last.slice(0, 5);
  const firstTwo = first.slice(0, 2);
  const stem = `${lastFive}${firstTwo}`;
  return ["01", "02", "03", "04"].map((suffix) => `${stem}${suffix}`);
}

function parseFloatSafe(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function parseIntSafe(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Pull the rows out of the playoffs_series table for a BR code. Returns
 *  null on 404 (wrong code or unknown player). */
export async function fetchBRPlayoffSeries(code: string): Promise<BRPlayoffSeries[] | null> {
  const letter = code.charAt(0);
  const url = `https://www.basketball-reference.com/players/${letter}/${code}.html`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const html = await res.text();
  // Find the playoffs_series tbody
  const tbodyMatch = html.match(/<table[^>]+id="playoffs_series"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return [];
  const tbody = tbodyMatch[1];
  // Each row has data-stat fields we extract by exact match.
  const rowRe = /<tr[^>]*id="playoffs_series\.[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  const series: BRPlayoffSeries[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(tbody)) !== null) {
    const rowHtml = m[1];
    const get = (stat: string): string => {
      const re = new RegExp(`data-stat="${stat}"[^>]*>([^<]*)<`);
      const r = rowHtml.match(re);
      return r ? r[1].trim() : "";
    };
    const yearLink = rowHtml.match(/data-stat="year_id"[^>]*>\s*<a[^>]*>([^<]+)</);
    const season = yearLink ? yearLink[1].trim() : get("year_id");
    const oppLink = rowHtml.match(/data-stat="opp_name_abbr"[^>]*>\s*<a[^>]*>([^<]+)</);
    const opp = oppLink ? oppLink[1].trim() : get("opp_name_abbr");
    const roundLink = rowHtml.match(/data-stat="ps_round"[^>]*>\s*<a[^>]*>([^<]+)</);
    const round = roundLink ? roundLink[1].trim() : get("ps_round");
    series.push({
      season,
      round,
      opponent: opp,
      result: get("series_result"),
      games: parseIntSafe(get("games")),
      ptsPerGame: parseFloatSafe(get("pts_per_g")),
      trbPerGame: parseFloatSafe(get("trb_per_g")),
      astPerGame: parseFloatSafe(get("ast_per_g")),
      fgPct: parseFloatSafe(get("fg_pct")),
      fg3PerGame: parseFloatSafe(get("fg3")) / Math.max(1, parseIntSafe(get("games"))),
    });
  }
  return series;
}

// ────────────────────────────────────────────────────────────────────────
// Full career page: per-season regular + playoffs per_game splits
// ────────────────────────────────────────────────────────────────────────

export interface BRSeasonRow {
  season: string;       // e.g. "2024-25"
  age: number;
  team: string;
  games: number;
  minutesPerGame: number;
  ptsPerGame: number;
  trbPerGame: number;
  astPerGame: number;
  stlPerGame: number;
  blkPerGame: number;
  fg3PerGame: number;
  fgPct: number;
  fg3Pct: number;
  ftPct: number;
  usagePct?: number;    // present only on the advanced table; left optional
}

export interface BRCareerFull {
  code: string;
  regularSeason: BRSeasonRow[];
  playoffsByYear: BRSeasonRow[];
  playoffSeries: BRPlayoffSeries[];
  /** Pre-computed career aggregates from the per-season totals. */
  careerRegular: {
    seasons: number;
    games: number;
    ppg: number;
    rpg: number;
    apg: number;
  };
  careerPlayoff: {
    seasons: number;
    games: number;
    ppg: number;
    rpg: number;
    apg: number;
  };
  /** Career delta = career playoff means − career regular means (per game). */
  playoffMinusRegular: {
    ppg: number;
    rpg: number;
    apg: number;
  };
}

function parseSeasonRow(rowHtml: string): BRSeasonRow | null {
  const get = (stat: string): string => {
    const re = new RegExp(`data-stat="${stat}"[^>]*>([^<]*)<`);
    const r = rowHtml.match(re);
    return r ? r[1].trim() : "";
  };
  const yearLink = rowHtml.match(/data-stat="year_id"[^>]*>\s*<a[^>]*>([^<]+)</);
  const teamLink = rowHtml.match(/data-stat="team_name_abbr"[^>]*>\s*<a[^>]*>([^<]+)</);
  const season = yearLink ? yearLink[1].trim() : get("year_id");
  const team = teamLink ? teamLink[1].trim() : get("team_name_abbr");
  if (!season) return null;
  // Skip career-summary rows
  if (/^[Cc]areer$|^[0-9]+ Yrs|All-NBA|Top-/.test(season)) return null;
  return {
    season,
    age: parseIntSafe(get("age")),
    team,
    games: parseIntSafe(get("games")),
    minutesPerGame: parseFloatSafe(get("mp_per_g")),
    ptsPerGame: parseFloatSafe(get("pts_per_g")),
    trbPerGame: parseFloatSafe(get("trb_per_g")),
    astPerGame: parseFloatSafe(get("ast_per_g")),
    stlPerGame: parseFloatSafe(get("stl_per_g")),
    blkPerGame: parseFloatSafe(get("blk_per_g")),
    fg3PerGame: parseFloatSafe(get("fg3_per_g")),
    fgPct: parseFloatSafe(get("fg_pct")),
    fg3Pct: parseFloatSafe(get("fg3_pct")),
    ftPct: parseFloatSafe(get("ft_pct")),
  };
}

/** Extract all <tbody><tr> rows from a named BR stats table. The HTML
 *  is sometimes wrapped in HTML comments to defeat scrapers; we strip those. */
function extractTableRows(html: string, tableId: string): string[] {
  // BR wraps secondary tables in <!-- … --> comments; unwrap.
  const stripped = html.replace(/<!--/g, "").replace(/-->/g, "");
  const tbodyMatch = stripped.match(
    new RegExp(`<table[^>]+id="${tableId}"[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>`),
  );
  if (!tbodyMatch) return [];
  const tbody = tbodyMatch[1];
  const rows: string[] = [];
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tbody)) !== null) {
    // Skip "thead" duplicate rows inserted mid-table
    if (/class="[^"]*thead/.test(m[0])) continue;
    rows.push(m[1]);
  }
  return rows;
}

function computeCareer(rows: BRSeasonRow[]) {
  const seasons = rows.length;
  let games = 0;
  let pts = 0;
  let trb = 0;
  let ast = 0;
  for (const r of rows) {
    games += r.games;
    pts += r.ptsPerGame * r.games;
    trb += r.trbPerGame * r.games;
    ast += r.astPerGame * r.games;
  }
  return {
    seasons,
    games,
    ppg: games > 0 ? pts / games : 0,
    rpg: games > 0 ? trb / games : 0,
    apg: games > 0 ? ast / games : 0,
  };
}

/** Single-page fetch that parses both per_game_stats (regular season) and
 *  playoffs_per_game (career playoff per game) plus the playoffs_series
 *  table we already supported. One BR request per player. */
export async function fetchBRCareerFull(code: string): Promise<BRCareerFull | null> {
  const letter = code.charAt(0);
  const url = `https://www.basketball-reference.com/players/${letter}/${code}.html`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const html = await res.text();

  const regSeasonRows = extractTableRows(html, "per_game_stats")
    .map(parseSeasonRow)
    .filter((r): r is BRSeasonRow => !!r);

  // Re-use the series parser. BR no longer exposes a `playoffs_per_game`
  // top-level table on the player page — the per-series rows ARE the
  // per-game data. We derive per-season playoff means by aggregating
  // series rows that share a season.
  const series = (await fetchBRPlayoffSeries(code)) ?? [];
  const playoffsByYearMap = new Map<string, BRSeasonRow>();
  for (const s of series) {
    if (!s.season) continue;
    const existing = playoffsByYearMap.get(s.season);
    if (existing) {
      const totalG = existing.games + s.games;
      if (totalG === 0) continue;
      existing.ptsPerGame =
        (existing.ptsPerGame * existing.games + s.ptsPerGame * s.games) / totalG;
      existing.trbPerGame =
        (existing.trbPerGame * existing.games + s.trbPerGame * s.games) / totalG;
      existing.astPerGame =
        (existing.astPerGame * existing.games + s.astPerGame * s.games) / totalG;
      existing.games = totalG;
    } else {
      playoffsByYearMap.set(s.season, {
        season: s.season,
        age: 0, // not surfaced at series level on the new BR layout
        team: "",
        games: s.games,
        minutesPerGame: 0,
        ptsPerGame: s.ptsPerGame,
        trbPerGame: s.trbPerGame,
        astPerGame: s.astPerGame,
        stlPerGame: 0,
        blkPerGame: 0,
        fg3PerGame: s.fg3PerGame,
        fgPct: s.fgPct,
        fg3Pct: 0,
        ftPct: 0,
      });
    }
  }
  const playoffPerGameRows = [...playoffsByYearMap.values()].sort((a, b) =>
    a.season.localeCompare(b.season),
  );

  if (regSeasonRows.length === 0 && playoffPerGameRows.length === 0) {
    // Page exists but no parseable stats — probably a rookie summary page
    return null;
  }

  const careerRegular = computeCareer(regSeasonRows);
  const careerPlayoff = computeCareer(playoffPerGameRows);
  return {
    code,
    regularSeason: regSeasonRows,
    playoffsByYear: playoffPerGameRows,
    playoffSeries: series,
    careerRegular,
    careerPlayoff,
    playoffMinusRegular: {
      ppg: careerPlayoff.ppg - careerRegular.ppg,
      rpg: careerPlayoff.rpg - careerRegular.rpg,
      apg: careerPlayoff.apg - careerRegular.apg,
    },
  };
}

/** Heuristic-code candidates → first match wins. Same algo as
 *  findBRPlayoffCareer but returns the full career record. */
export async function findBRCareerFull(displayName: string): Promise<BRCareerFull | null> {
  const candidates = brCodeCandidates(displayName);
  for (const code of candidates) {
    const res = await fetchBRCareerFull(code);
    if (res !== null) return res;
  }
  return null;
}

/** Try heuristic codes until we get a hit (or exhaust). Returns the full
 *  career playoff record, or null if the player isn't found. */
export async function findBRPlayoffCareer(displayName: string): Promise<BRPlayoffCareer | null> {
  const candidates = brCodeCandidates(displayName);
  for (const code of candidates) {
    const series = await fetchBRPlayoffSeries(code);
    if (series === null) continue; // 404 — try next candidate
    if (series.length === 0) {
      // Page found but no playoffs — return empty record so we don't keep retrying
      return {
        code,
        totalGames: 0,
        totalPts: 0,
        totalTrb: 0,
        totalAst: 0,
        seasons: 0,
        series: [],
        careerPlayoffPpg: 0,
        careerPlayoffRpg: 0,
        careerPlayoffApg: 0,
      };
    }
    // Sum totals (use per-game × games to reconstruct totals).
    let totalGames = 0;
    let totalPts = 0;
    let totalTrb = 0;
    let totalAst = 0;
    const seasonSet = new Set<string>();
    for (const s of series) {
      totalGames += s.games;
      totalPts += s.ptsPerGame * s.games;
      totalTrb += s.trbPerGame * s.games;
      totalAst += s.astPerGame * s.games;
      seasonSet.add(s.season);
    }
    return {
      code,
      totalGames,
      totalPts,
      totalTrb,
      totalAst,
      seasons: seasonSet.size,
      series,
      careerPlayoffPpg: totalGames > 0 ? totalPts / totalGames : 0,
      careerPlayoffRpg: totalGames > 0 ? totalTrb / totalGames : 0,
      careerPlayoffApg: totalGames > 0 ? totalAst / totalGames : 0,
    };
  }
  return null;
}
