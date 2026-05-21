/**
 * Live in-game stats — pulls the current boxscore for any NBA / WNBA / MLB
 * game that's currently in progress (or just-final, in case PrizePicks is
 * still letting the line settle) and exposes per-player current stat values
 * keyed by sport + normalized player name.
 *
 *   NBA / WNBA → ESPN public scoreboard + summary boxscore
 *   MLB        → MLB Stats API schedule + boxscore (no auth)
 *
 * No keys needed. Both endpoints are the same ones used by espn.com /
 * mlb.com themselves so they handle real game traffic.
 */

export interface LiveGameStat {
  sport: "NBA" | "WNBA" | "MLB";
  playerName: string;
  /** lowercased + diacritic-stripped, for fuzzy match against PrizePicks names */
  playerNameNormalized: string;
  team?: string;            // abbreviation, e.g. "OKC"
  opponent?: string;        // abbreviation
  homeAway?: "home" | "away";
  homeScore?: number;
  awayScore?: number;
  /** "Q3 4:32" or "T5" or "FINAL" */
  periodLabel: string;
  isFinal: boolean;
  /** Per-stat current values, keyed by short ESPN/MLB label (PTS, REB, H, R, HR, ...) */
  stats: Record<string, number>;
}

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'`’]/g, "")
    .toLowerCase()
    .trim();
}

function numFromUnknown(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// ESPN — NBA / WNBA
// ═══════════════════════════════════════════════════════════════════════

interface EspnEvent {
  id: string;
  status?: {
    type?: { state?: string };
    displayClock?: string;
    period?: number;
  };
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: "home" | "away";
      team?: { abbreviation?: string };
      score?: string;
    }>;
  }>;
}

interface EspnScoreboardResponse {
  events?: EspnEvent[];
}

interface EspnSummaryAthlete {
  athlete?: { displayName?: string };
  stats?: string[];
  starter?: boolean;
}

interface EspnSummaryTeam {
  team?: { abbreviation?: string };
  statistics?: Array<{
    labels?: string[];
    athletes?: EspnSummaryAthlete[];
  }>;
}

interface EspnSummaryResponse {
  boxscore?: { players?: EspnSummaryTeam[] };
}

function formatBasketballPeriod(ev: EspnEvent): string {
  const state = ev.status?.type?.state;
  if (state === "post") return "FINAL";
  if (state === "pre") return "PRE";
  const period = ev.status?.period;
  const clock = ev.status?.displayClock?.trim();
  if (!period) return clock || "LIVE";
  const label = period <= 4 ? `Q${period}` : `OT${period - 4}`;
  return clock ? `${label} ${clock}` : label;
}

/** Parse "8-18" (made-attempted) or "12" → number (made value, or raw). */
function parseStatCell(raw: string | undefined): number {
  if (!raw) return 0;
  if (raw.includes("-")) {
    const made = parseFloat(raw.split("-")[0]);
    return Number.isFinite(made) ? made : 0;
  }
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

async function fetchEspnScoreboard(league: "nba" | "wnba"): Promise<EspnEvent[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/${league}/scoreboard`;
  try {
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return [];
    const data = (await res.json()) as EspnScoreboardResponse;
    return data.events ?? [];
  } catch {
    return [];
  }
}

async function fetchEspnSummary(
  league: "nba" | "wnba",
  eventId: string,
): Promise<EspnSummaryResponse | null> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/${league}/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    return (await res.json()) as EspnSummaryResponse;
  } catch {
    return null;
  }
}

async function basketballLiveStats(league: "nba" | "wnba"): Promise<LiveGameStat[]> {
  const events = await fetchEspnScoreboard(league);
  // "in" = in-progress. Include "post" so just-final games still show their
  // final boxscore — useful if the user opens the board right after a game ends.
  const liveOrFinal = events.filter((e) => {
    const state = e.status?.type?.state;
    return state === "in" || state === "post";
  });
  if (liveOrFinal.length === 0) return [];

  const out: LiveGameStat[] = [];
  // Fan-out summary fetches in parallel — usually only 1-5 live games at a time
  const summaries = await Promise.all(liveOrFinal.map((ev) => fetchEspnSummary(league, ev.id)));

  for (let i = 0; i < liveOrFinal.length; i++) {
    const ev = liveOrFinal[i];
    const summary = summaries[i];
    if (!summary?.boxscore?.players) continue;

    const comps = ev.competitions?.[0]?.competitors ?? [];
    const home = comps.find((c) => c.homeAway === "home");
    const away = comps.find((c) => c.homeAway === "away");
    const homeAbbr = home?.team?.abbreviation ?? "";
    const awayAbbr = away?.team?.abbreviation ?? "";
    const homeScore = home?.score ? Number(home.score) : undefined;
    const awayScore = away?.score ? Number(away.score) : undefined;
    const periodLabel = formatBasketballPeriod(ev);
    const isFinal = ev.status?.type?.state === "post";

    for (const teamData of summary.boxscore.players) {
      const teamAbbr = teamData.team?.abbreviation ?? "";
      const homeAway: "home" | "away" | undefined =
        teamAbbr === homeAbbr ? "home" : teamAbbr === awayAbbr ? "away" : undefined;
      const opponent = teamAbbr === homeAbbr ? awayAbbr : homeAbbr;

      for (const grp of teamData.statistics ?? []) {
        const labels = grp.labels ?? [];
        for (const a of grp.athletes ?? []) {
          const name = a.athlete?.displayName;
          if (!name) continue;
          const arr = a.stats ?? [];

          const stats: Record<string, number> = {};
          for (let j = 0; j < labels.length; j++) {
            stats[labels[j]] = parseStatCell(arr[j]);
          }

          out.push({
            sport: league.toUpperCase() as "NBA" | "WNBA",
            playerName: name,
            playerNameNormalized: normalize(name),
            team: teamAbbr,
            opponent,
            homeAway,
            homeScore,
            awayScore,
            periodLabel,
            isFinal,
            stats,
          });
        }
      }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// MLB Stats API
// ═══════════════════════════════════════════════════════════════════════

interface MlbScheduleGame {
  gamePk: number;
  status?: { abstractGameState?: string };
  teams?: {
    home?: { team?: { abbreviation?: string } };
    away?: { team?: { abbreviation?: string } };
  };
  linescore?: {
    currentInning?: number;
    inningHalf?: string;
  };
}

interface MlbScheduleResponse {
  dates?: Array<{ games?: MlbScheduleGame[] }>;
}

interface MlbBoxscorePlayer {
  person?: { fullName?: string };
  stats?: {
    batting?: Record<string, unknown>;
    pitching?: Record<string, unknown>;
  };
}

interface MlbBoxscoreTeam {
  team?: { abbreviation?: string };
  players?: Record<string, MlbBoxscorePlayer>;
}

interface MlbBoxscoreResponse {
  teams?: { home?: MlbBoxscoreTeam; away?: MlbBoxscoreTeam };
}

interface MlbLinescoreResponse {
  currentInning?: number;
  inningHalf?: string;
  inningState?: string;
  teams?: {
    home?: { runs?: number };
    away?: { runs?: number };
  };
}

function mlbDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatMlbPeriod(linescore: MlbLinescoreResponse | null, isFinal: boolean): string {
  if (isFinal) return "FINAL";
  const inning = linescore?.currentInning;
  if (!inning) return "LIVE";
  const half = (linescore?.inningHalf ?? "").toLowerCase();
  const prefix = half === "top" ? "T" : half === "bottom" ? "B" : "";
  return `${prefix}${inning}`;
}

/** Parse "5.2" innings-pitched string to total outs (5*3 + 2). */
function inningsToOuts(ip: unknown): number {
  if (typeof ip === "number") return Math.round(ip * 3);
  if (typeof ip !== "string") return 0;
  const parts = ip.split(".");
  const full = parseInt(parts[0] ?? "0", 10) || 0;
  const partial = parseInt(parts[1] ?? "0", 10) || 0;
  return full * 3 + partial;
}

async function mlbLiveStats(): Promise<LiveGameStat[]> {
  const today = mlbDateString(new Date());
  const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=team,linescore`;
  let schedule: MlbScheduleResponse;
  try {
    const res = await fetch(scheduleUrl, { next: { revalidate: 60 } });
    if (!res.ok) return [];
    schedule = (await res.json()) as MlbScheduleResponse;
  } catch {
    return [];
  }

  const games = (schedule.dates?.[0]?.games ?? []).filter((g) => {
    const s = g.status?.abstractGameState;
    return s === "Live" || s === "Final";
  });
  if (games.length === 0) return [];

  // Boxscore + linescore in parallel per game
  const fetches = games.map(async (g) => {
    try {
      const [boxRes, lineRes] = await Promise.all([
        fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`, {
          next: { revalidate: 30 },
        }),
        fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/linescore`, {
          next: { revalidate: 30 },
        }),
      ]);
      const box = boxRes.ok ? ((await boxRes.json()) as MlbBoxscoreResponse) : null;
      const line = lineRes.ok ? ((await lineRes.json()) as MlbLinescoreResponse) : null;
      return { g, box, line };
    } catch {
      return { g, box: null, line: null };
    }
  });

  const results = await Promise.all(fetches);
  const out: LiveGameStat[] = [];

  for (const { g, box, line } of results) {
    if (!box) continue;
    const isFinal = g.status?.abstractGameState === "Final";
    const periodLabel = formatMlbPeriod(line, isFinal);
    const homeScore = line?.teams?.home?.runs;
    const awayScore = line?.teams?.away?.runs;
    const homeAbbr =
      box.teams?.home?.team?.abbreviation ?? g.teams?.home?.team?.abbreviation ?? "";
    const awayAbbr =
      box.teams?.away?.team?.abbreviation ?? g.teams?.away?.team?.abbreviation ?? "";

    for (const side of ["home", "away"] as const) {
      const teamData = box.teams?.[side];
      if (!teamData?.players) continue;
      const teamAbbr = side === "home" ? homeAbbr : awayAbbr;
      const opponent = side === "home" ? awayAbbr : homeAbbr;

      for (const key of Object.keys(teamData.players)) {
        const p = teamData.players[key];
        const name = p.person?.fullName;
        if (!name) continue;
        const b = p.stats?.batting ?? {};
        const pi = p.stats?.pitching ?? {};

        const hits = numFromUnknown(b.hits);
        const doubles = numFromUnknown(b.doubles);
        const triples = numFromUnknown(b.triples);
        const hr = numFromUnknown(b.homeRuns);

        const stats: Record<string, number> = {
          // batting
          H: hits,
          AB: numFromUnknown(b.atBats),
          R: numFromUnknown(b.runs),
          HR: hr,
          RBI: numFromUnknown(b.rbi),
          BB: numFromUnknown(b.baseOnBalls),
          SB: numFromUnknown(b.stolenBases),
          K: numFromUnknown(b.strikeOuts),
          "2B": doubles,
          "3B": triples,
          TB: numFromUnknown(b.totalBases) || hits + doubles + 2 * triples + 3 * hr,
          // pitching
          IPouts: inningsToOuts(pi.inningsPitched),
          PK: numFromUnknown(pi.strikeOuts),
          ER: numFromUnknown(pi.earnedRuns),
          PH: numFromUnknown(pi.hits),
          PBB: numFromUnknown(pi.baseOnBalls),
          PT: numFromUnknown(pi.pitchesThrown ?? pi.numberOfPitches),
        };

        out.push({
          sport: "MLB",
          playerName: name,
          playerNameNormalized: normalize(name),
          team: teamAbbr,
          opponent,
          homeAway: side,
          homeScore,
          awayScore,
          periodLabel,
          isFinal,
          stats,
        });
      }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Top-level — pull all sports in parallel
// ═══════════════════════════════════════════════════════════════════════

export async function getAllLiveStats(): Promise<LiveGameStat[]> {
  const [nba, wnba, mlb] = await Promise.all([
    basketballLiveStats("nba"),
    basketballLiveStats("wnba"),
    mlbLiveStats(),
  ]);
  return [...nba, ...wnba, ...mlb];
}

// ═══════════════════════════════════════════════════════════════════════
// Stat-type lookup — given a PrizePicks statType, compute the current value
// from the LiveGameStat.stats record
// ═══════════════════════════════════════════════════════════════════════

type Lookup = (s: Record<string, number>) => number | null;

function get(label: string): Lookup {
  return (s) => (s[label] !== undefined ? s[label] : null);
}

const STAT_LOOKUPS: Record<string, Lookup> = {
  // ── NBA / WNBA ──
  "points": get("PTS"),
  "pts": get("PTS"),
  "rebounds": get("REB"),
  "reb": get("REB"),
  "assists": get("AST"),
  "ast": get("AST"),
  "3pt made": get("3PT"),
  "3-pt made": get("3PT"),
  "threes": get("3PT"),
  "steals": get("STL"),
  "blocks": get("BLK"),
  "turnovers": get("TO"),
  "fg made": get("FG"),
  "ft made": get("FT"),
  "ftm": get("FT"),
  "free throws made": get("FT"),
  "minutes": get("MIN"),
  "pts+rebs": (s) => (s.PTS ?? 0) + (s.REB ?? 0),
  "pts+asts": (s) => (s.PTS ?? 0) + (s.AST ?? 0),
  "pts+rebs+asts": (s) => (s.PTS ?? 0) + (s.REB ?? 0) + (s.AST ?? 0),
  "pra": (s) => (s.PTS ?? 0) + (s.REB ?? 0) + (s.AST ?? 0),
  "rebs+asts": (s) => (s.REB ?? 0) + (s.AST ?? 0),
  "stocks": (s) => (s.STL ?? 0) + (s.BLK ?? 0),
  // ── MLB hitting ──
  "hits": get("H"),
  "hit": get("H"),
  "total bases": get("TB"),
  "tb": get("TB"),
  "walks": get("BB"),
  "walk": get("BB"),
  "bbs": get("BB"),
  "home runs": get("HR"),
  "hr": get("HR"),
  "hrs": get("HR"),
  "hitter strikeouts": get("K"),
  "hitter ks": get("K"),
  "runs": get("R"),
  "runs scored": get("R"),
  "rbis": get("RBI"),
  "rbi": get("RBI"),
  "stolen bases": get("SB"),
  "singles": (s) =>
    Math.max(0, (s.H ?? 0) - (s["2B"] ?? 0) - (s["3B"] ?? 0) - (s.HR ?? 0)),
  "doubles": get("2B"),
  "triples": get("3B"),
  "extra base hits": (s) => (s["2B"] ?? 0) + (s["3B"] ?? 0) + (s.HR ?? 0),
  "hits+runs+rbis": (s) => (s.H ?? 0) + (s.R ?? 0) + (s.RBI ?? 0),
  "hrr": (s) => (s.H ?? 0) + (s.R ?? 0) + (s.RBI ?? 0),
  // ── MLB pitching ──
  "pitcher strikeouts": get("PK"),
  "pitcher ks": get("PK"),
  "ks": get("PK"),
  "strikeouts": get("PK"),
  "pitching outs": get("IPouts"),
  "outs": get("IPouts"),
  "earned runs": get("ER"),
  "earned runs allowed": get("ER"),
  "hits allowed": get("PH"),
  "walks allowed": get("PBB"),
  "pitches thrown": get("PT"),
};

/** Returns the current value for `prop.statType` from the live game record, or null if unmapped. */
export function liveValueFor(stat: LiveGameStat, statType: string): number | null {
  const fn = STAT_LOOKUPS[statType.toLowerCase()];
  if (!fn) return null;
  const v = fn(stat.stats);
  return v !== null && Number.isFinite(v) ? v : null;
}

/**
 * Find the matching LiveGameStat for a prop, preferring same-team match.
 * Returns the live record + the computed stat value, or null if no match.
 */
export function matchPropToLive(
  live: LiveGameStat[],
  prop: { sport: string; playerName: string; team?: string; statType: string },
): { live: LiveGameStat; value: number } | null {
  const sport = prop.sport.toUpperCase() as "NBA" | "WNBA" | "MLB";
  if (sport !== "NBA" && sport !== "WNBA" && sport !== "MLB") return null;
  const target = normalize(prop.playerName);
  const candidates = live.filter((s) => s.sport === sport && s.playerNameNormalized === target);
  if (candidates.length === 0) return null;
  const best =
    (prop.team &&
      candidates.find((c) => (c.team ?? "").toUpperCase() === prop.team!.toUpperCase())) ||
    candidates[0];
  const value = liveValueFor(best, prop.statType);
  if (value === null) return null;
  return { live: best, value };
}
