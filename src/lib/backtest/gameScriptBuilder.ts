/**
 * Builder for the game-script residual profile + team scoring profile.
 *
 * Imported by both the backtest orchestrator (so calibration re-fits against
 * the model WITH this signal) and the standalone analyze script. Same maths
 * either way.
 */

import { ESPN_BASKETBALL_STATS, extractByLabel } from "@/lib/realProjections";
import type { PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";
import {
  bucketKey,
  type GameScriptCell,
  type GameScriptProfile,
  type RoleBucket,
  type TeamScoring,
} from "@/lib/backtest/gameScript";

const TRACKED_STATS = [
  "Points",
  "Rebounds",
  "Assists",
  "Pts+Rebs",
  "Pts+Asts",
  "Rebs+Asts",
  "Pts+Rebs+Asts",
] as const;

const STARTER_MIN_MINUTES = 25;
const MIN_PRIOR = 8;
const MIN_BUCKET_SAMPLE = 30;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface GameScriptBuildResult {
  profile: GameScriptProfile;
  scoring: TeamScoring;
  /** Diagnostic: how many events had both-sides coverage vs one-side. */
  coverage: { bothSides: number; oneSide: number };
  /** Diagnostic: total player-game residuals processed. */
  observations: number;
}

export function buildGameScript(players: PlayerGamelog[]): GameScriptBuildResult {
  // ── Pass 1: per-event team-points totals ─────────────────────────
  const eventTeamPts = new Map<string, Map<string, number>>();
  const eventTeams = new Map<string, Set<string>>();

  for (const p of players) {
    const team = (p.team || "").toUpperCase();
    if (!team || team === "—") continue;
    const meta = new Map(p.metaPairs);
    for (const ev of p.events) {
      const pts = extractByLabel(ev.stats, p.labels, "PTS");
      if (!Number.isFinite(pts) || pts < 0) continue;
      let row = eventTeamPts.get(ev.eventId);
      if (!row) {
        row = new Map();
        eventTeamPts.set(ev.eventId, row);
      }
      row.set(team, (row.get(team) ?? 0) + pts);

      let teams = eventTeams.get(ev.eventId);
      if (!teams) {
        teams = new Set();
        eventTeams.set(ev.eventId, teams);
      }
      teams.add(team);
      const opp = (meta.get(ev.eventId)?.opponentAbbr ?? "").toUpperCase();
      if (opp) teams.add(opp);
    }
  }

  // ── Pass 2: margins per (event, team) ────────────────────────────
  interface MarginRow {
    teamPts: number;
    oppPts: number;
    margin: number;
  }
  const marginByEventTeam = new Map<string, Map<string, MarginRow>>();
  let bothSides = 0;
  let oneSide = 0;
  for (const [eventId, ptsByTeam] of eventTeamPts) {
    const teams = [...(eventTeams.get(eventId) ?? [])];
    if (teams.length !== 2) {
      oneSide += 1;
      continue;
    }
    const [a, b] = teams;
    const ap = ptsByTeam.get(a);
    const bp = ptsByTeam.get(b);
    if (ap === undefined || bp === undefined) {
      oneSide += 1;
      continue;
    }
    const row = new Map<string, MarginRow>();
    row.set(a, { teamPts: ap, oppPts: bp, margin: ap - bp });
    row.set(b, { teamPts: bp, oppPts: ap, margin: bp - ap });
    marginByEventTeam.set(eventId, row);
    bothSides += 1;
  }

  // ── Pass 3: team scoring profile ─────────────────────────────────
  const teamAcc = new Map<string, { off: number; def: number; n: number }>();
  let leagueOffSum = 0;
  let leagueOffN = 0;
  for (const [, row] of marginByEventTeam) {
    for (const [team, m] of row) {
      let cell = teamAcc.get(team);
      if (!cell) {
        cell = { off: 0, def: 0, n: 0 };
        teamAcc.set(team, cell);
      }
      cell.off += m.teamPts;
      cell.def += m.oppPts;
      cell.n += 1;
      leagueOffSum += m.teamPts;
      leagueOffN += 1;
    }
  }
  const scoring: TeamScoring = {
    generatedAt: new Date().toISOString(),
    byTeam: {},
    leagueAvg: leagueOffN > 0 ? leagueOffSum / leagueOffN : 0,
  };
  for (const [team, c] of teamAcc) {
    if (c.n < 5) continue;
    scoring.byTeam[team] = {
      offRating: c.off / c.n,
      defRating: c.def / c.n,
      gamesObserved: c.n,
    };
  }

  // ── Pass 4: per-player roles ─────────────────────────────────────
  const playerRole = new Map<string, RoleBucket>();
  for (const p of players) {
    const mins: number[] = [];
    for (const ev of p.events) {
      const m = extractByLabel(ev.stats, p.labels, "MIN");
      if (Number.isFinite(m) && m > 0) mins.push(m);
    }
    const med = median(mins);
    playerRole.set(p.name, med >= STARTER_MIN_MINUTES ? "starter" : "bench");
  }

  // ── Pass 5: per-stat × per-bucket residuals ──────────────────────
  const accByStat: Record<string, Map<string, { sum: number; n: number }>> = {};
  for (const stat of TRACKED_STATS) accByStat[stat] = new Map();

  let observations = 0;
  for (const p of players) {
    const role = playerRole.get(p.name) ?? "bench";
    const eventsChrono = [...p.events].reverse();

    for (const stat of TRACKED_STATS) {
      const extractor = ESPN_BASKETBALL_STATS[stat];
      if (!extractor) continue;
      const values = eventsChrono.map((e) => extractor(e.stats, p.labels));

      for (let n = MIN_PRIOR; n < values.length; n++) {
        const v = values[n];
        if (!Number.isFinite(v) || v < 0) continue;
        const prior = values.slice(0, n).filter((x) => Number.isFinite(x) && x >= 0);
        if (prior.length < MIN_PRIOR) continue;
        const baseline = prior.reduce((a, b) => a + b, 0) / prior.length;
        const residual = v - baseline;

        const ev = eventsChrono[n];
        const margins = marginByEventTeam.get(ev.eventId);
        if (!margins) continue;
        const team = (p.team || "").toUpperCase();
        const teamMargin = margins.get(team);
        if (!teamMargin) continue;

        const key = bucketKey(teamMargin.margin > 0, teamMargin.margin, role);
        const slot = accByStat[stat];
        let cell = slot.get(key);
        if (!cell) {
          cell = { sum: 0, n: 0 };
          slot.set(key, cell);
        }
        cell.sum += residual;
        cell.n += 1;
        observations += 1;
      }
    }
  }

  // ── Finalize ─────────────────────────────────────────────────────
  const profile: GameScriptProfile = {
    generatedAt: new Date().toISOString(),
    byStat: {},
  };
  for (const stat of TRACKED_STATS) {
    const slot: Record<string, GameScriptCell> = {};
    for (const [key, c] of accByStat[stat]) {
      if (c.n < MIN_BUCKET_SAMPLE) continue;
      slot[key] = { mean: c.sum / c.n, n: c.n };
    }
    profile.byStat[stat] = slot;
  }

  return {
    profile,
    scoring,
    coverage: { bothSides, oneSide },
    observations,
  };
}
