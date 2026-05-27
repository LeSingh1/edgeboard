#!/usr/bin/env tsx
/**
 * Conference-finals deep history.
 *
 * For every player on a team still alive in the current 2025-26 NBA
 * playoffs (conference finals, "still competing"), pull their FULL
 * career data from Basketball-Reference:
 *
 *   - Year-by-year regular-season per_game splits
 *   - Year-by-year playoffs per_game splits
 *   - Career playoff series (already in playoffDeepLog.json)
 *
 * This is the "entire career on all circumstances" pass. It captures
 * career arc + playoff-vs-regular delta + per-season trajectory.
 *
 * Output:  data/backtest/conferenceFinalsCareer.json
 *
 * Run AFTER scripts/playoff-deep.ts so we don't compete with that
 * script's BR rate budget. Throttled at 1 player / 7s = ~8.5 req/min.
 *
 *   npx tsx scripts/conference-finals-deep.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fetchTeamRoster } from "@/lib/playoffRoster";
import { findBRCareerFull, type BRCareerFull } from "@/lib/basketballReference";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DATA_DIR = path.join(process.cwd(), "data", "backtest");
const OUT_PATH = path.join(DATA_DIR, "conferenceFinalsCareer.json");

// Discovery window: "still alive" = played a postseason game in the last
// 7 days. That captures the conference finals participants regardless of
// whether the series has wrapped on a given day.
const RECENT_DAYS = 7;

interface CFPlayerRecord {
  name: string;
  team: string;
  position?: string;
  espnId: number;
  brCareer: BRCareerFull | null;
}

interface CFDeepLog {
  generatedAt: string;
  stillCompetingTeams: string[];
  playerCount: number;
  brHitCount: number;
  byTeam: Record<string, CFPlayerRecord[]>;
  /** Aggregate stats for sanity-checking how rich the dataset is. */
  meta: {
    totalCareerSeasons: number;
    totalCareerGames: number;
    totalPlayoffSeasons: number;
    totalPlayoffGames: number;
  };
}

async function discoverStillCompeting(): Promise<string[]> {
  const end = new Date();
  const start = new Date(end.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?` +
    `dates=${fmt(start)}-${fmt(end)}&limit=100`;
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
    if (ev.season?.type !== 3) continue;
    for (const c of ev.competitions ?? []) {
      for (const t of c.competitors ?? []) {
        const ab = t.team?.abbreviation;
        if (ab) teams.add(ab);
      }
    }
  }
  return [...teams].sort();
}

async function main() {
  const t0 = Date.now();
  console.log(`[cf-deep] starting · ${new Date().toISOString()}`);

  console.log(`[cf-deep] discovering teams still competing (last ${RECENT_DAYS} days)…`);
  const teams = await discoverStillCompeting();
  console.log(`[cf-deep] discovered ${teams.length} teams: ${teams.join(", ")}`);

  const rosterResults = await Promise.all(
    teams.map(async (t) => {
      try {
        return { team: t, players: await fetchTeamRoster(t) };
      } catch {
        return { team: t, players: [] };
      }
    }),
  );

  const byTeam: Record<string, CFPlayerRecord[]> = {};
  let playerCount = 0;
  let brHitCount = 0;
  let totalCareerSeasons = 0;
  let totalCareerGames = 0;
  let totalPlayoffSeasons = 0;
  let totalPlayoffGames = 0;

  // Serial throttle on BR: one player every 7s. Total runtime budget
  // ≈ playerCount × 7s — for ~70 conference-finals players that's ~8 min.
  for (const { team, players } of rosterResults) {
    byTeam[team] = [];
    console.log(`[cf-deep] ${team}: ${players.length} players`);
    let teamHits = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      let career: BRCareerFull | null = null;
      try {
        career = await findBRCareerFull(p.name);
      } catch {
        career = null;
      }
      byTeam[team].push({
        name: p.name,
        team,
        position: p.position,
        espnId: p.espnId,
        brCareer: career,
      });
      playerCount++;
      if (career) {
        brHitCount++;
        teamHits++;
        totalCareerSeasons += career.regularSeason.length;
        totalCareerGames += career.careerRegular.games;
        totalPlayoffSeasons += career.playoffsByYear.length;
        totalPlayoffGames += career.careerPlayoff.games;
      }
      // Respect BR's politeness: 7s between requests (≈ 8.5 req/min).
      if (i + 1 < players.length) {
        await new Promise((r) => setTimeout(r, 7000));
      }
    }
    console.log(
      `[cf-deep]   → ${byTeam[team].length} players · ${teamHits} BR career hits`,
    );
  }

  const log: CFDeepLog = {
    generatedAt: new Date().toISOString(),
    stillCompetingTeams: teams,
    playerCount,
    brHitCount,
    byTeam,
    meta: {
      totalCareerSeasons,
      totalCareerGames,
      totalPlayoffSeasons,
      totalPlayoffGames,
    },
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(log, null, 2));
  console.log(`[cf-deep] wrote ${OUT_PATH}`);

  console.log("");
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Conference-finals deep history complete`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`  Teams still competing:    ${teams.length}`);
  console.log(`  Players covered:          ${playerCount}`);
  console.log(`  BR career hits:           ${brHitCount}`);
  console.log(`  Career regular seasons:   ${totalCareerSeasons}`);
  console.log(`  Career regular games:     ${totalCareerGames.toLocaleString()}`);
  console.log(`  Career playoff seasons:   ${totalPlayoffSeasons}`);
  console.log(`  Career playoff games:     ${totalPlayoffGames.toLocaleString()}`);
  console.log(`  Elapsed:                  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("[cf-deep] fatal:", err);
  process.exit(1);
});
