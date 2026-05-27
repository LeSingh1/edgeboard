#!/usr/bin/env tsx
/**
 * Deep playoff training pipeline.
 *
 * For each player on a team that made the 2025-26 Conference Semifinals
 * (Round 2), gather:
 *   1. Full ESPN gamelog (career-deep as the endpoint allows)
 *   2. Latest ESPN news / press-conference signals (via heuristicIntel)
 *   3. Per-game breakout-detection (≥1.5σ over rolling-mean), with full
 *      situational context: opponent, days rest, home/away, opponent
 *      defensive delta, regular vs playoff
 *
 * Outputs:
 *   data/backtest/playoffDeepLog.json   — per-player rich record
 *   data/backtest/playoffCalibration.json — isotonic curve fit on the
 *      playoff-only subset; the live model layers this on top of the base
 *      per-stat / per-oddsType calibration when isPlayoffDate is true.
 *
 * Run:  npx tsx scripts/playoff-deep.ts [--force]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fetchTeamRoster } from "@/lib/playoffRoster";
import {
  espnFindAthleteId,
  espnGameLog,
  ESPN_BASKETBALL_STATS,
  type EspnGamelogEvent,
  type EspnEventMeta,
} from "@/lib/realProjections";
import { fetchPlayerNews, fetchPlayerNewsViaTeam } from "@/lib/espnNews";
import { extractHeuristicSignals, type IntelSignal } from "@/lib/heuristicIntel";
import { isPlayoffDate } from "@/lib/playoffWindow";
import {
  buildDefenseRatings,
  defensiveDelta,
  type DefenseRatings,
} from "@/lib/backtest/defenseRatings";
import { fitCalibration, type CalibrationModel } from "@/lib/backtest/fitCalibration";
import type { PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";
import { findBRPlayoffCareer, type BRPlayoffCareer } from "@/lib/basketballReference";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DATA_DIR = path.join(process.cwd(), "data", "backtest");
const OUT_PATH = path.join(DATA_DIR, "playoffDeepLog.json");
const CAL_PATH = path.join(DATA_DIR, "playoffCalibration.json");
const ROUND2_TEAMS_PATH = path.join(DATA_DIR, "round2Teams.json");
const DEFENSE_PATH = path.join(DATA_DIR, "defenseRatings.json");
const GAMELOGS_PATH = path.join(DATA_DIR, "gamelogs.json");

const ROUND_2_START = "2026-05-05"; // approx; tightens via game-count check below

const STATS_TO_ANALYZE = [
  "Points",
  "Rebounds",
  "Assists",
  "3-PT Made",
  "Steals",
  "Blocks",
  "Pts+Rebs",
  "Pts+Asts",
  "Rebs+Asts",
  "Pts+Rebs+Asts",
];

// ────────────────────────────────────────────────────────────────────────
// 1. Round-2 team discovery
// ────────────────────────────────────────────────────────────────────────

/**
 * Pull every postseason game from the round-2-start cutoff to now.
 * Teams that played a postseason game in this window are by definition
 * round-2-or-later participants.
 */
async function discoverRound2Teams(): Promise<string[]> {
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const start = new Date(ROUND_2_START);
  const end = new Date();
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?` +
    `dates=${fmt(start)}-${fmt(end)}&limit=200`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const body = (await res.json()) as {
    events?: Array<{
      season?: { type?: number };
      competitions?: Array<{
        competitors?: Array<{ team?: { abbreviation?: string } }>;
      }>;
    }>;
  };
  const teams = new Set<string>();
  for (const ev of body.events ?? []) {
    if (ev.season?.type !== 3) continue; // postseason only
    for (const c of ev.competitions ?? []) {
      for (const t of c.competitors ?? []) {
        const ab = t.team?.abbreviation;
        if (ab) teams.add(ab);
      }
    }
  }
  return [...teams].sort();
}

// ────────────────────────────────────────────────────────────────────────
// 2. Breakout-game detection per player + stat
// ────────────────────────────────────────────────────────────────────────

interface BreakoutGame {
  date: string;
  stat: string;
  value: number;
  rollingMean: number;
  rollingStd: number;
  zScore: number;
  /** Situational context that the model would have seen pre-game. */
  context: {
    opponent: string;
    isHome: boolean | undefined;
    isPlayoff: boolean;
    daysRest: number | null;
    opponentDefenseDelta: number | null;
    opponentDefenseSample: number | null;
  };
}

/** Detect games where the player exceeded their rolling expectation by ≥1.5σ. */
function detectBreakouts(
  player: {
    name: string;
    labels: string[];
    events: EspnGamelogEvent[];
    metaPairs: Array<[string, EspnEventMeta]>;
  },
  defense: DefenseRatings | null,
): BreakoutGame[] {
  const meta = new Map(player.metaPairs);
  const eventsChrono = [...player.events].reverse(); // oldest → newest
  const out: BreakoutGame[] = [];

  for (const stat of STATS_TO_ANALYZE) {
    const extractor = ESPN_BASKETBALL_STATS[stat];
    if (!extractor) continue;
    const values: number[] = [];
    for (let i = 0; i < eventsChrono.length; i++) {
      const v = extractor(eventsChrono[i].stats, player.labels);
      if (!Number.isFinite(v) || v < 0) {
        values.push(NaN);
        continue;
      }
      values.push(v);
      // Need ≥ 8 prior games to compute a meaningful rolling mean+std.
      const prior = values.slice(0, i).filter((x) => Number.isFinite(x));
      if (prior.length < 8) continue;
      const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
      const std = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / prior.length);
      if (std < 0.1) continue; // ignore stats that don't move
      const z = (v - mean) / std;
      if (z < 1.5) continue;

      const m = meta.get(eventsChrono[i].eventId);
      const date = m?.gameDate ?? "";
      const opp = (m?.opponentAbbr ?? "").toUpperCase();
      const dd = opp && defense ? defensiveDelta(defense, opp, stat) : null;

      // Days rest from previous game
      let daysRest: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const prevMeta = meta.get(eventsChrono[j].eventId);
        if (prevMeta?.gameDate) {
          const a = new Date(prevMeta.gameDate).getTime();
          const b = new Date(date).getTime();
          if (Number.isFinite(a) && Number.isFinite(b)) {
            daysRest = Math.floor((b - a) / 86400000);
          }
          break;
        }
      }

      out.push({
        date,
        stat,
        value: v,
        rollingMean: Number(mean.toFixed(2)),
        rollingStd: Number(std.toFixed(2)),
        zScore: Number(z.toFixed(2)),
        context: {
          opponent: opp,
          isHome: m?.atVs === "vs" ? true : m?.atVs === "@" ? false : undefined,
          isPlayoff: isPlayoffDate(date),
          daysRest,
          opponentDefenseDelta: dd ? Number(dd.delta.toFixed(2)) : null,
          opponentDefenseSample: dd ? dd.sample : null,
        },
      });
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────────
// 3. Per-player record + main loop
// ────────────────────────────────────────────────────────────────────────

interface PlayoffPlayerRecord {
  name: string;
  team: string;
  position?: string;
  espnId: number;
  totalGames: number;
  playoffGames: number;
  career: {
    perStat: Record<
      string,
      {
        n: number;
        mean: number;
        std: number;
        playoffMean: number | null;
        playoffN: number;
        regularMean: number | null;
        regularN: number;
        delta: number | null; // playoff − regular
      }
    >;
  };
  breakouts: BreakoutGame[];
  intel: {
    signalCount: number;
    signals: IntelSignal[];
  };
  /** Career playoff history pulled from Basketball-Reference. Optional —
   *  null when the player has no BR match (rookies, undrafted, etc.). */
  brCareerPlayoffs: BRPlayoffCareer | null;
}

interface PlayoffDeepLog {
  generatedAt: string;
  round2Teams: string[];
  playerCount: number;
  byTeam: Record<string, PlayoffPlayerRecord[]>;
}

function statSummary(
  player: { labels: string[]; events: EspnGamelogEvent[]; metaPairs: Array<[string, EspnEventMeta]> },
  stat: string,
) {
  const extractor = ESPN_BASKETBALL_STATS[stat];
  if (!extractor) return null;
  const meta = new Map(player.metaPairs);
  const eventsChrono = [...player.events].reverse();
  const playoffVals: number[] = [];
  const regularVals: number[] = [];
  for (const ev of eventsChrono) {
    const v = extractor(ev.stats, player.labels);
    if (!Number.isFinite(v) || v < 0) continue;
    const m = meta.get(ev.eventId);
    const date = m?.gameDate ?? "";
    if (isPlayoffDate(date)) playoffVals.push(v);
    else regularVals.push(v);
  }
  const all = [...playoffVals, ...regularVals];
  if (all.length === 0) return null;
  const m = (arr: number[]) =>
    arr.length === 0 ? null : Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
  const mean = m(all)!;
  const std = Number(
    Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length).toFixed(2),
  );
  const playoffMean = m(playoffVals);
  const regularMean = m(regularVals);
  return {
    n: all.length,
    mean,
    std,
    playoffMean,
    playoffN: playoffVals.length,
    regularMean,
    regularN: regularVals.length,
    delta: playoffMean !== null && regularMean !== null ? Number((playoffMean - regularMean).toFixed(2)) : null,
  };
}

async function processPlayer(
  espnId: number,
  name: string,
  team: string,
  position: string | undefined,
  defense: DefenseRatings | null,
): Promise<PlayoffPlayerRecord | null> {
  try {
    const { labels, events, meta } = await espnGameLog(espnId, "nba");
    if (events.length === 0) return null;
    const metaPairs = Array.from(meta.entries());
    const playerLite = { name, labels, events, metaPairs };

    // Per-stat career summaries
    const perStat: PlayoffPlayerRecord["career"]["perStat"] = {};
    for (const stat of STATS_TO_ANALYZE) {
      const s = statSummary(playerLite, stat);
      if (s) perStat[stat] = s;
    }

    // Breakout games
    const breakouts = detectBreakouts(playerLite, defense);

    // Intel from current ESPN news. Primary path: team-scoped news filtered
    // by player name (the per-athlete HTML page no longer embeds article
    // JSON as of 2026). Fallback: the legacy player-page scrape, for
    // safety. All signals merged.
    let signals: IntelSignal[] = [];
    try {
      const [teamNews, playerNews] = await Promise.all([
        fetchPlayerNewsViaTeam({ playerName: name, teamAbbr: team }),
        fetchPlayerNews(espnId, "nba"),
      ]);
      const merged = [...teamNews, ...playerNews];
      signals = extractHeuristicSignals(merged, name);
    } catch {
      // best-effort; bench players often have nothing
    }

    const playoffGames = metaPairs.filter(
      ([, m]) => m && isPlayoffDate(m.gameDate),
    ).length;

    // Basketball-Reference career playoff history — multi-year depth that
    // ESPN's gamelog window doesn't cover. Best-effort; rookies / undrafted
    // / non-BR-indexed players return null.
    let brCareerPlayoffs: BRPlayoffCareer | null = null;
    try {
      brCareerPlayoffs = await findBRPlayoffCareer(name);
    } catch {
      // ignore — BR rate-limit or 5xx
    }

    return {
      name,
      team,
      position,
      espnId,
      totalGames: events.length,
      playoffGames,
      career: { perStat },
      breakouts: breakouts.slice(0, 30), // cap to top-30 per player to keep file size sane
      intel: { signalCount: signals.length, signals },
      brCareerPlayoffs,
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 4. Fit playoff-only calibration over the cached training corpus
// ────────────────────────────────────────────────────────────────────────

async function fitPlayoffCalibration(round2Teams: Set<string>): Promise<CalibrationModel | null> {
  // We reuse the cached gamelogs.json (whole-league corpus, 535 players),
  // re-synthesize lines, score with the live scoreModel, and subset to
  // (game-date in playoff window) AND (player's team in round-2 set).
  const cacheRaw = await fs.readFile(GAMELOGS_PATH, "utf8").catch(() => null);
  if (!cacheRaw) {
    console.warn("[playoff-deep] no gamelogs.json — skipping playoff calibration fit");
    return null;
  }
  const cache = JSON.parse(cacheRaw) as { players: PlayerGamelog[] };

  const defenseRaw = await fs.readFile(DEFENSE_PATH, "utf8").catch(() => null);
  const defense = defenseRaw ? (JSON.parse(defenseRaw) as DefenseRatings) : null;

  // Synthesize + score (mirror the backtest pipeline, scoped to playoff games)
  const { synthesizeAllRows } = await import("@/lib/backtest/synthesizeLines");
  const { scoreModel } = await import("@/lib/backtest/scoreModel");
  const rows = synthesizeAllRows(cache.players);
  const byName = new Map(cache.players.map((p) => [p.name, p]));

  const pairs: Array<{ predicted: number; hit: boolean }> = [];
  for (const row of rows) {
    if (!isPlayoffDate(row.date)) continue;
    const player = byName.get(row.player);
    if (!player) continue;
    if (!round2Teams.has(player.team.toUpperCase())) continue;
    for (const variant of [
      { key: "standardLine" as const, oddsType: "standard" as const },
      { key: "goblinLine" as const, oddsType: "goblin" as const },
      { key: "demonLine" as const, oddsType: "demon" as const },
    ]) {
      const line = row[variant.key];
      const out = scoreModel({
        player,
        chronoIndex: row.chronoIndex,
        stat: row.stat,
        line,
        oddsType: variant.oddsType,
        propOpponent: row.opponent,
        propIsHome: row.atVs === "vs" ? true : row.atVs === "@" ? false : undefined,
        propGameTime: row.date,
        defenseRatings: defense ?? undefined,
      });
      if (!out) continue;
      const side = out.pMore >= 0.5 ? "more" : "less";
      const predicted = side === "more" ? out.pMore : out.pLess;
      const hit =
        side === "more" ? row.actualValue > line : row.actualValue < line;
      pairs.push({ predicted, hit });
    }
  }

  console.log(
    `[playoff-deep] playoff-only calibration: fitting on ${pairs.length.toLocaleString()} pairs`,
  );
  if (pairs.length < 200) return null;
  return fitCalibration(pairs);
}

// ────────────────────────────────────────────────────────────────────────
// 5. Main
// ────────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("[playoff-deep] starting");

  console.log("[playoff-deep] discovering Round-2 teams (postseason games on/after", ROUND_2_START, ")");
  const teams = await discoverRound2Teams();
  console.log(`[playoff-deep] discovered ${teams.length} round-2 teams: ${teams.join(", ")}`);
  const teamSet = new Set(teams.map((t) => t.toUpperCase()));

  // Load defense ratings for breakout context
  const defenseRaw = await fs.readFile(DEFENSE_PATH, "utf8").catch(() => null);
  const defense = defenseRaw ? (JSON.parse(defenseRaw) as DefenseRatings) : null;
  if (!defense) {
    console.warn("[playoff-deep] no defenseRatings.json — breakout context will lack defense delta");
  }

  // Fetch rosters for each team in parallel
  console.log("[playoff-deep] fetching rosters for each team…");
  const rosterResults = await Promise.all(
    teams.map(async (t) => {
      try {
        const r = await fetchTeamRoster(t);
        return { team: t, players: r };
      } catch {
        return { team: t, players: [] };
      }
    }),
  );

  const byTeam: Record<string, PlayoffPlayerRecord[]> = {};
  let playerCount = 0;

  // Process players — batches of 2 with 8s sleep. Each player now hits
  // three endpoints (ESPN gamelog + ESPN news + Basketball-Reference);
  // BR's rate limit (~20 req/min) is the binding constraint, so we keep
  // BR throughput at ~15 req/min via batch×interval = 2/8s.
  for (const { team, players } of rosterResults) {
    byTeam[team] = [];
    console.log(`[playoff-deep] ${team}: ${players.length} players`);
    const batchSize = 2;
    for (let i = 0; i < players.length; i += batchSize) {
      const batch = players.slice(i, i + batchSize);
      const records = await Promise.all(
        batch.map((p) =>
          processPlayer(p.espnId, p.name, team, p.position, defense),
        ),
      );
      for (const r of records) {
        if (r) {
          byTeam[team].push(r);
          playerCount++;
        }
      }
      if (i + batchSize < players.length) {
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
    const breakoutsThisTeam = byTeam[team].reduce((s, p) => s + p.breakouts.length, 0);
    const intelSignals = byTeam[team].reduce((s, p) => s + p.intel.signalCount, 0);
    const brHits = byTeam[team].filter(
      (p) => p.brCareerPlayoffs && p.brCareerPlayoffs.totalGames > 0,
    ).length;
    console.log(
      `[playoff-deep]   → ${byTeam[team].length} players processed · ` +
        `${breakoutsThisTeam} breakouts · ${intelSignals} intel signals · ` +
        `${brHits} BR career-playoff hits`,
    );
  }

  const log: PlayoffDeepLog = {
    generatedAt: new Date().toISOString(),
    round2Teams: teams,
    playerCount,
    byTeam,
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(log, null, 2));
  console.log(`[playoff-deep] wrote ${OUT_PATH} (${playerCount} players across ${teams.length} teams)`);

  // Write the team list separately so the live model can gate playoff
  // calibration on team membership (not just on date being in window).
  await fs.writeFile(
    ROUND2_TEAMS_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), teams }, null, 2),
  );
  console.log(`[playoff-deep] wrote ${ROUND2_TEAMS_PATH}`);

  // Fit playoff-only calibration over the cached training corpus
  const playoffCalibration = await fitPlayoffCalibration(teamSet);
  if (playoffCalibration) {
    await fs.writeFile(CAL_PATH, JSON.stringify(playoffCalibration, null, 2));
    console.log(
      `[playoff-deep] wrote ${CAL_PATH} ` +
        `(${playoffCalibration.breakpoints.length} breakpoints from ${playoffCalibration.trainingSize.toLocaleString()} pairs)`,
    );
  } else {
    console.warn("[playoff-deep] insufficient playoff-only data to fit a calibration");
  }

  // Summary
  let totalBreakouts = 0;
  let totalIntelSignals = 0;
  for (const team of Object.keys(byTeam)) {
    for (const p of byTeam[team]) {
      totalBreakouts += p.breakouts.length;
      totalIntelSignals += p.intel.signalCount;
    }
  }
  console.log("");
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Deep playoff training complete`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Round-2 teams:     ${teams.length}`);
  console.log(`  Players processed: ${playerCount}`);
  console.log(`  Breakout games:    ${totalBreakouts}`);
  console.log(`  Intel signals:     ${totalIntelSignals}`);
  console.log(`  Elapsed:           ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("[playoff-deep] fatal:", err);
  process.exit(1);
});
