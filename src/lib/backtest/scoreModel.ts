/**
 * Pure projection model for the backtest pipeline.
 *
 * Lifts the math from `realProjections.ts:buildResult` + `applyAdjustments`
 * into a function that operates on a pre-fetched gamelog window and a
 * specific date cutoff, with no network access. Same sigma floor, same
 * normal CDF, same clamps, same four adjustment signals.
 *
 * Critically: we use the SAME extractors (`ESPN_BASKETBALL_STATS`) the
 * live model uses, so the backtest tests the actual model, not a twin
 * that might drift.
 *
 * No look-ahead: the caller passes `chronoIndex` (the target game's
 * position in the chronological gamelog), and we use only games
 * [0..chronoIndex - 1] for the projection. The target game itself is
 * never visible to the model.
 */

import { ESPN_BASKETBALL_STATS } from "@/lib/realProjections";
import { MODEL_CONSTANTS, type ModelConstants } from "@/lib/modelConstants";
import type { PlayerGamelog } from "@/lib/backtest/fetchSeasonLogs";
import { defensiveDelta, type DefenseRatings } from "@/lib/backtest/defenseRatings";
import { isPlayoffDate } from "@/lib/playoffWindow";
import {
  breakoutExcess,
  type BreakoutProfiles,
} from "@/lib/backtest/breakoutProfile";

export interface ScoreInput {
  player: PlayerGamelog;
  /** Chronological index of the target game (0 = season opener). Only games
   *  strictly before this index are visible to the model. */
  chronoIndex: number;
  stat: string;
  line: number;
  oddsType: "standard" | "goblin" | "demon";
  /** Opponent of the TARGET game — used for vs-opp adjustment. */
  propOpponent?: string;
  /** Whether the target game is home for the player. */
  propIsHome?: boolean;
  /** ISO timestamp of the target game — used for days-rest adjustment. */
  propGameTime?: string;
  /** Override model constants. Defaults to MODEL_CONSTANTS. The offline
   *  tuner uses this to grid-search alternative values without forking
   *  the scoring function. */
  constants?: ModelConstants;
  /** Per-team defensive ratings. When provided, fires the opponent-defense
   *  signal. Optional — omit to keep parity with the original model. */
  defenseRatings?: DefenseRatings;
  /** Per-player breakout-rate profiles. When provided + player has data,
   *  fires the breakout-context signal. */
  breakoutProfiles?: BreakoutProfiles;
}

export interface ScoreOutput {
  pMore: number;
  pLess: number;
  /** Projection mean (pre-adjustment). */
  baselineProjection: number;
  /** Projection mean after all adjustments. */
  projection: number;
  sigma: number;
  sampleSize: number;
}

/** Abramowitz-Stegun approximation of normal CDF. Same as the live model. */
function cdfNormal(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y =
    1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function meanStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** Probability of going OVER the line, given mean + sigma. */
function pMoreFromZ(line: number, mean: number, sigma: number): number {
  const z = (line - mean) / sigma;
  return 1 - cdfNormal(z);
}

/** Map a chronoIndex to its date/opponent/atVs in the player's history. */
function indexLookup(player: PlayerGamelog): {
  dates: (string | undefined)[];
  opponents: (string | undefined)[];
  atVs: (string | undefined)[];
} {
  const meta = new Map(player.metaPairs);
  const eventsChrono = [...player.events].reverse();
  return {
    dates: eventsChrono.map((e) => meta.get(e.eventId)?.gameDate),
    opponents: eventsChrono.map((e) => meta.get(e.eventId)?.opponentAbbr),
    atVs: eventsChrono.map((e) => meta.get(e.eventId)?.atVs),
  };
}

/**
 * Run the heuristic projection model against a single (player, game, line,
 * oddsType) tuple. Returns the same shape the live model exposes (minus
 * the news-driven intel swing, which isn't part of the backtest scope).
 */
export function scoreModel(input: ScoreInput): ScoreOutput | null {
  const C = input.constants ?? MODEL_CONSTANTS;
  const { player, chronoIndex, stat, line } = input;
  const extractor = ESPN_BASKETBALL_STATS[stat];
  if (!extractor) return null;

  const eventsChrono = [...player.events].reverse();
  const allValues = eventsChrono.map((e) => extractor(e.stats, player.labels));
  const priorValues = allValues.slice(0, chronoIndex);
  if (priorValues.length < 8) return null;

  // ── Baseline projection from rolling mean / sigma ────────────────
  const { mean, std } = meanStd(priorValues);
  const sigma = Math.max(std, mean * C.sigmaFloorMultiplier, C.sigmaFloorAbsolute);
  const baselineProjection = mean;

  let adjustedMean = baselineProjection;
  const seasonMean = baselineProjection;

  const { dates, opponents, atVs } = indexLookup(player);
  // Restrict every signal's window to the prior games — chronoIndex strict.
  const priorDates = dates.slice(0, chronoIndex);
  const priorOpponents = opponents.slice(0, chronoIndex);
  const priorAtVs = atVs.slice(0, chronoIndex);
  const propGameTime = input.propGameTime ?? dates[chronoIndex];

  // ── (1) Recent form: last 5 vs season ────────────────────────────
  if (priorValues.length >= 8) {
    const lastN = priorValues.slice(-5);
    const recentMean = lastN.reduce((a, b) => a + b, 0) / lastN.length;
    const shift = recentMean - seasonMean;
    if (Math.abs(shift) > sigma * C.recentFormShiftThresholdSigma) {
      adjustedMean += shift * C.recentFormConfidence;
    }
  }

  // ── (2) vs Opponent: ≥2 prior games against this team ────────────
  if (input.propOpponent) {
    const target = input.propOpponent.toUpperCase();
    const vsValues: number[] = [];
    for (let i = 0; i < priorValues.length; i++) {
      const opp = (priorOpponents[i] ?? "").toUpperCase();
      if (
        opp &&
        (opp === target || target.startsWith(opp) || opp.startsWith(target))
      ) {
        vsValues.push(priorValues[i]);
      }
    }
    if (vsValues.length >= 2) {
      const vsMean = vsValues.reduce((a, b) => a + b, 0) / vsValues.length;
      const shift = vsMean - seasonMean;
      if (Math.abs(shift) > sigma * C.vsOppShiftThresholdSigma) {
        const confidence = Math.min(
          C.vsOppConfidenceCap,
          C.vsOppConfidenceBase + vsValues.length * C.vsOppConfidencePerGame,
        );
        adjustedMean += shift * confidence;
      }
    }
  }

  // ── (3) Home / Away split: ≥4 prior games each side ─────────────
  if (input.propIsHome !== undefined) {
    const homeVals: number[] = [];
    const awayVals: number[] = [];
    for (let i = 0; i < priorValues.length; i++) {
      const tag = (priorAtVs[i] ?? "").trim();
      if (tag === "vs") homeVals.push(priorValues[i]);
      else if (tag === "@") awayVals.push(priorValues[i]);
    }
    if (homeVals.length >= 4 && awayVals.length >= 4) {
      const homeMean = homeVals.reduce((a, b) => a + b, 0) / homeVals.length;
      const awayMean = awayVals.reduce((a, b) => a + b, 0) / awayVals.length;
      const targetMean = input.propIsHome ? homeMean : awayMean;
      const shift = targetMean - seasonMean;
      if (Math.abs(shift) > sigma * C.homeAwayShiftThresholdSigma) {
        const minSide = Math.min(homeVals.length, awayVals.length);
        const confidence = Math.min(
          C.homeAwayConfidenceCap,
          C.homeAwayConfidenceBase + minSide * C.homeAwayConfidencePerSide,
        );
        adjustedMean += shift * confidence;
      }
    }
  }

  // ── (4) Days rest: bucket gamelog gaps, match the target's rest ──
  //   Bucketing: B2B (gap ≤ 1 day) / 1-day-rest (gap = 2) / 2+ rest (gap ≥ 3).
  //   Back-to-back is the fatigue-driven case; we collapse 0 and 1 day
  //   spreads because ESPN gamelog dates sometimes carry timestamps that
  //   put consecutive-calendar-day games at 0 days and sometimes at 1.
  if (propGameTime) {
    const propDay = new Date(propGameTime).getTime();
    if (Number.isFinite(propDay)) {
      let prevDay: number | null = null;
      for (let i = priorDates.length - 1; i >= 0; i--) {
        const d = priorDates[i];
        if (!d) continue;
        const t = new Date(d).getTime();
        if (Number.isFinite(t) && t < propDay) {
          prevDay = t;
          break;
        }
      }
      if (prevDay !== null) {
        const daysRest = Math.floor((propDay - prevDay) / (24 * 60 * 60 * 1000));
        const restBucket = daysRest <= 1 ? 0 : daysRest === 2 ? 1 : 2; // 0=B2B, 1=1-day, 2=2+
        const bucketValues: number[] = [];
        for (let i = 1; i < priorDates.length; i++) {
          const da = priorDates[i - 1];
          const db = priorDates[i];
          if (!da || !db) continue;
          const gap = Math.floor(
            (new Date(db).getTime() - new Date(da).getTime()) / (24 * 60 * 60 * 1000),
          );
          if (!Number.isFinite(gap) || gap < 0) continue;
          const gameBucket = gap <= 1 ? 0 : gap === 2 ? 1 : 2;
          if (gameBucket === restBucket) bucketValues.push(priorValues[i]);
        }
        if (bucketValues.length >= 5) {
          const bucketMean =
            bucketValues.reduce((a, b) => a + b, 0) / bucketValues.length;
          const shift = bucketMean - seasonMean;
          if (Math.abs(shift) > sigma * C.daysRestShiftThresholdSigma) {
            const confidence = Math.min(
              C.daysRestConfidenceCap,
              C.daysRestConfidenceBase + bucketValues.length * C.daysRestConfidencePerGame,
            );
            adjustedMean += shift * confidence;
          }
        }
      }
    }
  }

  // ── (5) Opponent defensive rating ───────────────────────────────
  //   Shift toward the opponent team's typical allowance for this stat.
  //   Sample-based confidence; only fires when |delta| meaningful.
  if (input.propOpponent && input.defenseRatings) {
    const dd = defensiveDelta(input.defenseRatings, input.propOpponent, stat);
    if (dd && Math.abs(dd.delta) > sigma * C.defenseRatingShiftThresholdSigma) {
      const buckets30 = Math.floor(dd.sample / 30);
      const confidence = Math.min(
        C.defenseRatingConfidenceCap,
        C.defenseRatingConfidenceBase + buckets30 * C.defenseRatingConfidencePer30Games,
      );
      adjustedMean += dd.delta * confidence;
    }
  }

  // ── (5b) Contextual breakout signal ──────────────────────────────
  if (input.breakoutProfiles && input.propOpponent) {
    const oppDelta =
      defensiveDelta(input.defenseRatings ?? ({ byTeam: {}, leagueAvg: {} } as DefenseRatings), input.propOpponent, stat)?.delta ?? null;
    const breakout = breakoutExcess({
      profiles: input.breakoutProfiles,
      playerName: player.name,
      stat,
      context: {
        opponentDefenseDelta: oppDelta,
        isHome: input.propIsHome,
        isPlayoff: !!propGameTime && isPlayoffDate(propGameTime),
      },
    });
    if (breakout) {
      adjustedMean += breakout.excess * sigma * C.breakoutShiftSigmaScale * C.breakoutConfidence;
    }
  }

  // ── (6) Playoff vs regular-season split ─────────────────────────
  //   When the target game is a playoff game, compare the player's prior
  //   playoff output to their regular-season output. Stars typically gain
  //   minutes/usage; depth pieces typically lose them.
  if (propGameTime && isPlayoffDate(propGameTime)) {
    const playoffVals: number[] = [];
    const regVals: number[] = [];
    for (let i = 0; i < priorDates.length; i++) {
      const d = priorDates[i];
      if (!d) continue;
      if (isPlayoffDate(d)) playoffVals.push(priorValues[i]);
      else regVals.push(priorValues[i]);
    }
    if (playoffVals.length >= 3 && regVals.length >= 5) {
      const pMean = playoffVals.reduce((a, b) => a + b, 0) / playoffVals.length;
      const rMean = regVals.reduce((a, b) => a + b, 0) / regVals.length;
      const shift = pMean - rMean;
      if (Math.abs(shift) > sigma * C.playoffShiftThresholdSigma) {
        const confidence = Math.min(
          C.playoffConfidenceCap,
          C.playoffConfidenceBase + playoffVals.length * C.playoffConfidencePerGame,
        );
        adjustedMean += shift * confidence;
      }
    }
  }

  // ── Final pMore from adjusted mean ───────────────────────────────
  const pMoreRaw = pMoreFromZ(line, adjustedMean, sigma);
  const pMore = Math.max(C.pMoreClampLow, Math.min(C.pMoreClampHigh, pMoreRaw));
  return {
    pMore,
    pLess: 1 - pMore,
    baselineProjection,
    projection: adjustedMean,
    sigma,
    sampleSize: priorValues.length,
  };
}
