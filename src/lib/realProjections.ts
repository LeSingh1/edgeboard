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
import { MODEL_CONSTANTS as C } from "@/lib/modelConstants";
import { calibrate, getCalibration } from "@/lib/applyCalibration";
import { kalshiSignalFor, blendPMore, type KalshiSignal } from "@/lib/kalshi";
import type { OddsTypeKey } from "@/lib/backtest/fitCalibration";
export type { OddsTypeKey };
import {
  getDefenseRatings,
  getDefensiveDeltaSync,
} from "@/lib/applyDefenseRatings";
import { isPlayoffDate } from "@/lib/playoffWindow";
import {
  getBreakoutProfiles,
  breakoutExcessSync,
} from "@/lib/applyBreakoutProfile";
import {
  getPlayoffCalibration,
  getRound2Teams,
  isRound2TeamSync,
  applyPlayoffCalibrationSync,
} from "@/lib/applyPlayoffCalibration";
import {
  getGameScript,
  getGameScriptDeltaSync,
  getExpectedMarginSync,
} from "@/lib/applyGameScript";

export interface ProjectionAdjustment {
  /** "Recent form", "vs NY Knicks", "Home/Away", etc. */
  label: string;
  /** Mean shift applied (additive on the projection mean). e.g. +1.3 = projection bumped up. */
  shift: number;
  /** Final pMore swing this adjustment caused (signed, 0..1 absolute). */
  pMoreSwing: number;
  /** Human reason: "last 5 games avg 28.4 vs season 25.1" */
  reason: string;
  /** How much to trust this signal: 0..1. Small samples = lower confidence. */
  confidence: number;
}

export interface RecentGameMeta {
  /** Opponent abbreviation for THIS game (not the current prop's opponent). */
  opponent?: string;
  /** ISO date string of THIS game. */
  date?: string;
  /** "@" away, "vs" home. */
  atVs?: string;
}

export interface RealProjection {
  pMore: number;              // FINAL pMore after all adjustments
  pLess: number;
  projection: number;         // FINAL projection mean after all adjustments
  sigma: number;
  sampleSize: number;
  recent: number[];           // last few raw values for the chart / explainer
  /** Per-game metadata aligned 1:1 with `recent`. Optional — only populated
   *  on the NBA/WNBA path, where we carry opponents/dates through. */
  recentMeta?: RecentGameMeta[];
  source: string;             // e.g. "MLB Stats API · last 49 games"
  modelVersion: string;       // e.g. "mlb-rolling-v1"
  /** Baseline (pre-adjustment) projection for transparency in the explainer. */
  baselineProjection?: number;
  baselinePMore?: number;
  /** Per-signal breakdown of what moved the number from baseline → final. */
  adjustments?: ProjectionAdjustment[];
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
  // Floor sigma so we don't divide by ~0 for very tight stats. The
  // multiplier is now tunable via MODEL_CONSTANTS so the offline tuner
  // can search for a value that calibrates the model better.
  const sigma = Math.max(std, mean * C.sigmaFloorMultiplier, C.sigmaFloorAbsolute);
  const z = (line - mean) / sigma;
  const pMore = 1 - cdfNormal(z);
  return {
    available: true,
    pMore: r3(Math.max(C.pMoreClampLow, Math.min(C.pMoreClampHigh, pMore))),
    pLess: r3(1 - Math.max(C.pMoreClampLow, Math.min(C.pMoreClampHigh, pMore))),
    projection: r3(mean),
    sigma: r3(sigma),
    sampleSize: values.length,
    recent: values.slice(-10),
    source: `${source} · last ${values.length} games`,
    modelVersion,
  };
}

/**
 * Apply stat-driven adjustments (recent form, vs-opponent, home/away) to a baseline
 * result. Each adjustment shifts the projection mean and is recorded in the
 * `adjustments` array so the UI can show the breakdown to the user.
 *
 * Adjustments are SHIFTS not MULTIPLIERS — additive on the mean — because for
 * counting stats like points/rebounds, a "10% bump in form" feels like "shift +2
 * on a 20 PPG line" rather than "multiply line by 1.1".
 */
function applyAdjustments(
  baseline: RealProjection & { available: true },
  line: number,
  signals: {
    /** Recent values in chronological order (oldest → newest), aligned with events. */
    chronoValues: number[];
    /** Per-game opponent abbreviation, aligned with chronoValues. */
    opponents: (string | undefined)[];
    /** Per-game "@" (away) or "vs" (home), aligned with chronoValues. */
    atVs?: (string | undefined)[];
    /** Per-game ISO dates, aligned with chronoValues. */
    dates?: (string | undefined)[];
    /** Abbreviation for the prop's opponent — case-insensitive match. */
    propOpponent?: string;
    /** Whether the player's team is HOME in the prop's game. Drives the home/away signal. */
    propIsHome?: boolean;
    /** ISO timestamp of the prop's game — used to compute days-rest from the
     *  previous gamelog entry. */
    propGameTime?: string;
    /** Stat name (e.g. "Points") — used by the defensive-rating signal. */
    propStat?: string;
    /** Player display name — used by the breakout-profile lookup. */
    playerName?: string;
    /** Player's team abbreviation — needed for expected-margin estimation
     *  in the game-script signal. */
    propTeam?: string;
    /** Per-game minutes aligned 1:1 with `chronoValues`. Median minutes
     *  classifies the player as starter/bench in the game-script bucket
     *  lookup. */
    minutes?: number[];
    /** Net pMore swing from press-conference / news intel (`heuristicIntel.ts`
     *  + `claudeIntel.ts`), pre-computed by the caller and passed in. Positive =
     *  intel favors MORE. Applied as a direct probability swing AFTER the
     *  mean-based signals — intel speaks to outcomes, not the mean. */
    intelSwing?: number;
    /** Short evidence string from the intel pipeline, surfaced in the
     *  adjustments breakdown row. Optional cosmetic. */
    intelEvidence?: string;
  },
): ProjectionResult {
  const adjustments: ProjectionAdjustment[] = [];
  let adjustedMean = baseline.projection;
  const sigma = baseline.sigma;

  const seasonMean = baseline.projection;

  // ── (1) Recent form: last 5 vs season ──
  if (signals.chronoValues.length >= 8) {
    const lastN = signals.chronoValues.slice(-5);
    const recentMean = lastN.reduce((a, b) => a + b, 0) / lastN.length;
    const shift = recentMean - seasonMean;
    if (Math.abs(shift) > sigma * C.recentFormShiftThresholdSigma) {
      // Only record when the deviation is meaningful (threshold tuned via
      // MODEL_CONSTANTS.recentFormShiftThresholdSigma). Confidence is
      // also tunable via .recentFormConfidence.
      const confidence = C.recentFormConfidence;
      const blendedShift = shift * confidence;
      adjustments.push({
        label: "Recent form",
        shift: r3(blendedShift),
        pMoreSwing: 0, // filled in below after we know final pMore
        reason:
          `Last 5 games avg ${r3(recentMean)} vs season ${r3(seasonMean)} ` +
          `(${shift >= 0 ? "hot" : "cold"} streak)`,
        confidence,
      });
      adjustedMean += blendedShift;
    }
  }

  // ── (2) vs Opponent: games against this specific team ──
  if (signals.propOpponent && signals.chronoValues.length === signals.opponents.length) {
    const target = signals.propOpponent.toUpperCase();
    const vsValues: number[] = [];
    for (let i = 0; i < signals.chronoValues.length; i++) {
      const opp = (signals.opponents[i] ?? "").toUpperCase();
      if (opp && (opp === target || target.startsWith(opp) || opp.startsWith(target))) {
        vsValues.push(signals.chronoValues[i]);
      }
    }
    if (vsValues.length >= 2) {
      const vsMean = vsValues.reduce((a, b) => a + b, 0) / vsValues.length;
      const shift = vsMean - seasonMean;
      if (Math.abs(shift) > sigma * C.vsOppShiftThresholdSigma) {
        // Confidence scales with vs-opp sample size — base + perGame × n,
        // capped. All three are tunable via MODEL_CONSTANTS.
        const confidence = Math.min(
          C.vsOppConfidenceCap,
          C.vsOppConfidenceBase + vsValues.length * C.vsOppConfidencePerGame,
        );
        const blendedShift = shift * confidence;
        adjustments.push({
          label: `vs ${signals.propOpponent}`,
          shift: r3(blendedShift),
          pMoreSwing: 0,
          reason:
            `${vsValues.length} game${vsValues.length === 1 ? "" : "s"} vs ${signals.propOpponent}: ` +
            `avg ${r3(vsMean)} (${shift >= 0 ? "+" : ""}${r3(shift)} vs season)`,
          confidence,
        });
        adjustedMean += blendedShift;
      }
    }
  }

  // ── (3) Home / Away split ──
  // Most players have measurably different output at home vs on the road.
  // Use the gamelog's atVs flag — "vs" means home, "@" means away. Need both
  // to compute a meaningful split (else we'd compare to the full season,
  // double-counting noise).
  if (
    signals.propIsHome !== undefined &&
    signals.atVs &&
    signals.chronoValues.length === signals.atVs.length
  ) {
    const homeVals: number[] = [];
    const awayVals: number[] = [];
    for (let i = 0; i < signals.chronoValues.length; i++) {
      const tag = (signals.atVs[i] ?? "").trim();
      if (tag === "vs") homeVals.push(signals.chronoValues[i]);
      else if (tag === "@") awayVals.push(signals.chronoValues[i]);
    }
    if (homeVals.length >= 4 && awayVals.length >= 4) {
      const homeMean = homeVals.reduce((a, b) => a + b, 0) / homeVals.length;
      const awayMean = awayVals.reduce((a, b) => a + b, 0) / awayVals.length;
      const targetMean = signals.propIsHome ? homeMean : awayMean;
      const shift = targetMean - seasonMean;
      if (Math.abs(shift) > sigma * C.homeAwayShiftThresholdSigma) {
        // Confidence grows with the smaller side's count — tunable scale
        // (Base + PerSide × minN, capped) via MODEL_CONSTANTS.
        const minSide = Math.min(homeVals.length, awayVals.length);
        const confidence = Math.min(
          C.homeAwayConfidenceCap,
          C.homeAwayConfidenceBase + minSide * C.homeAwayConfidencePerSide,
        );
        const blendedShift = shift * confidence;
        const where = signals.propIsHome ? "at home" : "on the road";
        adjustments.push({
          label: signals.propIsHome ? "Home games" : "Road games",
          shift: r3(blendedShift),
          pMoreSwing: 0,
          reason:
            `${homeVals.length}H avg ${r3(homeMean)} · ${awayVals.length}A avg ${r3(awayMean)}. ` +
            `Playing ${where} ${shift >= 0 ? "favors" : "hurts"} MORE.`,
          confidence,
        });
        adjustedMean += blendedShift;
      }
    }
  }

  // ── (4) Days rest ──
  // 0-rest (back-to-back) is a measurable fatigue penalty in NBA/WNBA;
  // 3+ rest days is "fresh." Compare the prop's days-rest vs the player's
  // gamelog distribution.
  if (
    signals.propGameTime &&
    signals.dates &&
    signals.chronoValues.length === signals.dates.length
  ) {
    const propDay = new Date(signals.propGameTime).getTime();
    if (Number.isFinite(propDay)) {
      // Find the most recent game in the gamelog (the entry whose date is BEFORE propDay)
      let prevDay: number | null = null;
      for (let i = signals.dates.length - 1; i >= 0; i--) {
        const d = signals.dates[i];
        if (!d) continue;
        const t = new Date(d).getTime();
        if (Number.isFinite(t) && t < propDay) {
          prevDay = t;
          break;
        }
      }
      if (prevDay !== null) {
        const daysRest = Math.floor((propDay - prevDay) / (24 * 60 * 60 * 1000));
        // Bucketing: B2B (≤1d) / 1-day rest (=2d) / 2+ rest (≥3d).
        // Consecutive-day games sometimes parse as 0 and sometimes as 1 depending
        // on whether ESPN includes timestamps; collapsing those preserves the
        // fatigue signal across both cases.
        const restBucket = daysRest <= 1 ? 0 : daysRest === 2 ? 1 : 2;
        const bucketValues: number[] = [];
        for (let i = 1; i < signals.dates.length; i++) {
          const da = signals.dates[i - 1];
          const db = signals.dates[i];
          if (!da || !db) continue;
          const gap = Math.floor(
            (new Date(db).getTime() - new Date(da).getTime()) / (24 * 60 * 60 * 1000),
          );
          if (!Number.isFinite(gap) || gap < 0) continue;
          const gameBucket = gap <= 1 ? 0 : gap === 2 ? 1 : 2;
          if (gameBucket === restBucket) bucketValues.push(signals.chronoValues[i]);
        }
        if (bucketValues.length >= 5) {
          const bucketMean = bucketValues.reduce((a, b) => a + b, 0) / bucketValues.length;
          const shift = bucketMean - seasonMean;
          if (Math.abs(shift) > sigma * C.daysRestShiftThresholdSigma) {
            const confidence = Math.min(
              C.daysRestConfidenceCap,
              C.daysRestConfidenceBase + bucketValues.length * C.daysRestConfidencePerGame,
            );
            const blendedShift = shift * confidence;
            const restLabel =
              restBucket === 0 ? "Back-to-back" : restBucket === 1 ? "1 day rest" : "2+ days rest";
            adjustments.push({
              label: restLabel,
              shift: r3(blendedShift),
              pMoreSwing: 0,
              reason:
                `${bucketValues.length} past games on this rest pattern: ` +
                `avg ${r3(bucketMean)} (${shift >= 0 ? "+" : ""}${r3(shift)} vs season).`,
              confidence,
            });
            adjustedMean += blendedShift;
          }
        }
      }
    }
  }

  // ── (5) Opponent defensive rating ────────────────────────────────
  //   Loaded from `data/backtest/defenseRatings.json`. If absent or stale
  //   the signal silently no-ops.
  if (signals.propOpponent && signals.propStat) {
    const dd = getDefensiveDeltaSync(signals.propOpponent, signals.propStat);
    if (dd && Math.abs(dd.delta) > sigma * C.defenseRatingShiftThresholdSigma) {
      const buckets30 = Math.floor(dd.sample / 30);
      const confidence = Math.min(
        C.defenseRatingConfidenceCap,
        C.defenseRatingConfidenceBase + buckets30 * C.defenseRatingConfidencePer30Games,
      );
      const blendedShift = dd.delta * confidence;
      adjustments.push({
        label: `${signals.propOpponent} defense`,
        shift: r3(blendedShift),
        pMoreSwing: 0,
        reason:
          `${signals.propOpponent} allows ${r3(dd.delta)} more ${signals.propStat.toLowerCase()} ` +
          `per game than league avg (${dd.sample} games observed).`,
        confidence,
      });
      adjustedMean += blendedShift;
    }
  }

  // ── (5b) Contextual breakout signal ──────────────────────────────
  //   Per-player breakout-frequency profile. When the player's rate in
  //   the current context bucket exceeds the league baseline by 1.3x,
  //   apply an upward shift proportional to the excess × σ × confidence.
  if (signals.playerName && signals.propStat) {
    const oppDelta =
      signals.propOpponent
        ? (getDefensiveDeltaSync(signals.propOpponent, signals.propStat)?.delta ?? null)
        : null;
    const breakout = breakoutExcessSync({
      playerName: signals.playerName,
      stat: signals.propStat,
      context: {
        opponentDefenseDelta: oppDelta,
        isHome: signals.propIsHome,
        isPlayoff: !!signals.propGameTime && isPlayoffDate(signals.propGameTime),
      },
    });
    if (breakout) {
      // The shift is breakout EXCESS × sigma × scale × confidence.
      // Excess (e.g. 0.18 = 18 pts above league baseline) × σ × scale gives a
      // shift on the projection-mean axis; multiplied by the breakout confidence.
      const blendedShift =
        breakout.excess * sigma * C.breakoutShiftSigmaScale * C.breakoutConfidence;
      adjustments.push({
        label: "Breakout history",
        shift: r3(blendedShift),
        pMoreSwing: 0,
        reason:
          `Player breaks out ${(breakout.excess * 100).toFixed(0)}pp more often than league avg ` +
          `in this context (${breakout.bucket}, ${breakout.sample} games).`,
        confidence: C.breakoutConfidence,
      });
      adjustedMean += blendedShift;
    }
  }

  // ── (6) Playoff vs regular-season split ──────────────────────────
  //   When the target game is in the playoff window, compare the player's
  //   prior playoff output to their regular-season output for the same stat.
  if (signals.propGameTime && isPlayoffDate(signals.propGameTime) && signals.dates) {
    const playoffVals: number[] = [];
    const regVals: number[] = [];
    for (let i = 0; i < signals.dates.length; i++) {
      const d = signals.dates[i];
      if (!d) continue;
      if (isPlayoffDate(d)) playoffVals.push(signals.chronoValues[i]);
      else regVals.push(signals.chronoValues[i]);
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
        const blendedShift = shift * confidence;
        adjustments.push({
          label: "Playoff context",
          shift: r3(blendedShift),
          pMoreSwing: 0,
          reason:
            `${playoffVals.length} playoff games avg ${r3(pMean)} vs ` +
            `${regVals.length} regular-season games avg ${r3(rMean)}.`,
          confidence,
        });
        adjustedMean += blendedShift;
      }
    }
  }

  // ── (7) Game-script / blowout context ───────────────────────────
  //   When the matchup projects to a decisive margin, starters on the
  //   expected losing side and bench guys on the winning side see their
  //   minutes flipped relative to season baseline. Bucketed residuals
  //   trained on the full 2025-26 corpus capture the typical shift.
  if (signals.propTeam && signals.propOpponent && signals.propStat) {
    const em = getExpectedMarginSync(signals.propTeam, signals.propOpponent);
    if (em && Math.abs(em.margin) >= C.gameScriptMinMargin && signals.minutes && signals.minutes.length >= 5) {
      const sortedMins = [...signals.minutes].filter((m) => Number.isFinite(m) && m > 0).sort((a, b) => a - b);
      if (sortedMins.length >= 5) {
        const mid = Math.floor(sortedMins.length / 2);
        const medMin = sortedMins.length % 2
          ? sortedMins[mid]
          : (sortedMins[mid - 1] + sortedMins[mid]) / 2;
        const isStarter = medMin >= 25;
        const gs = getGameScriptDeltaSync({
          stat: signals.propStat,
          expectedMargin: em.margin,
          teamWillWin: em.margin > 0,
          isStarter,
        });
        if (gs && gs.sample >= C.gameScriptMinSample) {
          const blendedShift = gs.delta * C.gameScriptConfidence;
          const marginAbs = Math.abs(em.margin);
          const marginLabel =
            marginAbs <= 7 ? "close" : marginAbs <= 15 ? "decisive" : "blowout";
          const sideLabel = em.margin > 0 ? "expected win" : "expected loss";
          adjustments.push({
            label: `Game script (${marginLabel} ${sideLabel})`,
            shift: r3(blendedShift),
            pMoreSwing: 0,
            reason:
              `Projected margin ${r3(em.margin)} pts. ${isStarter ? "Starter" : "Bench"} ${signals.propStat.toLowerCase()} ` +
              `in ${marginLabel} ${em.margin > 0 ? "wins" : "losses"} averages ` +
              `${gs.delta >= 0 ? "+" : ""}${r3(gs.delta)} vs rolling baseline (${gs.sample} games).`,
            confidence: C.gameScriptConfidence,
          });
          adjustedMean += blendedShift;
        }
      }
    }
  }

  const hasIntelSwing = typeof signals.intelSwing === "number" && Math.abs(signals.intelSwing) > 1e-4;

  // No adjustments fired AND no intel swing → return baseline untouched
  if (adjustments.length === 0 && !hasIntelSwing) return baseline;

  // Recompute pMore from the adjusted mean (intel swing applied after).
  const adjZ = (line - adjustedMean) / sigma;
  let meanAdjustedPMore = Math.max(C.pMoreClampLow, Math.min(C.pMoreClampHigh, 1 - cdfNormal(adjZ)));

  // Back-fill mean-based adjustments' pMore swing for the UI breakdown.
  const totalShift = adjustments.reduce((s, a) => s + a.shift, 0);
  const meanSwing = meanAdjustedPMore - baseline.pMore;
  for (const a of adjustments) {
    a.pMoreSwing = r3(totalShift === 0 ? 0 : (a.shift / totalShift) * meanSwing);
  }

  // Apply intel swing AFTER mean-based signals. Intel speaks to outcomes,
  // not to the mean — clamp the same way we clamp the mean-based path.
  if (hasIntelSwing) {
    const intelSwing = signals.intelSwing!;
    const intelAdjusted = Math.max(
      C.pMoreClampLow,
      Math.min(C.pMoreClampHigh, meanAdjustedPMore + intelSwing),
    );
    const actualIntelSwing = intelAdjusted - meanAdjustedPMore;
    adjustments.push({
      label: "Press conference / news",
      shift: 0, // intel doesn't shift the mean
      pMoreSwing: r3(actualIntelSwing),
      reason:
        signals.intelEvidence ||
        `Aggregated heuristic + Claude signals from team news + press conferences.`,
      confidence: 1,
    });
    meanAdjustedPMore = intelAdjusted;
  }
  const adjustedPMore = meanAdjustedPMore;

  // Align the last-N opponent / date metadata with the last-N `recent`
  // values so the UI can render the actual opponent of each game (not the
  // current prop's opponent for every row). Slice tail.
  const n = baseline.recent.length;
  let recentMeta: RecentGameMeta[] | undefined;
  if (
    n > 0 &&
    signals.chronoValues.length === signals.opponents.length &&
    (!signals.dates || signals.chronoValues.length === signals.dates.length)
  ) {
    const len = signals.chronoValues.length;
    recentMeta = [];
    for (let k = 0; k < n; k++) {
      const idx = len - n + k;
      if (idx < 0) {
        recentMeta.push({});
      } else {
        recentMeta.push({
          opponent: signals.opponents[idx],
          date: signals.dates?.[idx],
          atVs: signals.atVs?.[idx],
        });
      }
    }
  }

  return {
    ...baseline,
    projection: r3(adjustedMean),
    pMore: r3(adjustedPMore),
    pLess: r3(1 - adjustedPMore),
    baselineProjection: baseline.projection,
    baselinePMore: baseline.pMore,
    adjustments,
    recentMeta,
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

export function extractByLabel(stats: string[], labels: string[], label: string): number {
  const i = labels.indexOf(label);
  if (i === -1) return 0;
  const raw = stats[i] ?? "";
  if (raw.includes("-")) return parseFloat(raw.split("-")[0]) || 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

export type EspnStatExtractor = (stats: string[], labels: string[]) => number;

export const ESPN_BASKETBALL_STATS: Record<string, EspnStatExtractor> = {
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
  // OREB / DREB intentionally NOT here — ESPN gamelog only carries total REB.
  // Those stat types are handled via the derived-rebound path in nbaProjection()
  // using ESPN's per-season averages endpoint (which DOES split OR/DR).
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

export interface EspnGamelogEvent {
  eventId: string;
  stats: string[];
}

/** Event metadata pulled from the gamelog's parallel `events` lookup table. */
export interface EspnEventMeta {
  eventId: string;
  gameDate?: string;             // ISO timestamp
  opponentAbbr?: string;         // "NY", "BOS", etc.
  atVs?: string;                 // "@" (away) or "vs" (home)
}

export async function espnFindAthleteId(
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

/**
 * Which ESPN seasons we train the projection model on for a given league.
 *
 * WNBA gets the prior + current season because the WNBA regular season is
 * short (~40 games) and runs May–Sep, so in May/June the current-season
 * gamelog is too sparse to model anyone. Pulling 2025 + 2026 takes a typical
 * Satou Sabally from 3 games (refuses to project) to ~54 games (stable mean).
 *
 * NBA stays single-season — the 82-game regular season provides ample sample
 * by November, and players' roles shift more between seasons than in the
 * WNBA, so mixing prior-year data is more likely to bias than help.
 */
function trainingSeasonsFor(league: "nba" | "wnba"): number[] {
  if (league !== "wnba") return [];
  // WNBA season runs May–Sep. Whatever calendar year it is, pull this year
  // and last year. After Oct 1 the league is in offseason, so just keep both.
  const now = new Date();
  const year = now.getFullYear();
  return [year - 1, year];
}

/** Fetch one season's gamelog from ESPN.
 *  - `season` omitted → ESPN's current-season default
 *  - `season` set    → that specific season (e.g. 2025 for the 2025 regular season) */
async function fetchSingleSeasonGamelog(
  athleteId: number,
  league: "nba" | "wnba",
  season?: number,
): Promise<{
  labels: string[];
  events: EspnGamelogEvent[];
  meta: Map<string, EspnEventMeta>;
}> {
  const url =
    `https://site.web.api.espn.com/apis/common/v3/sports/basketball/${league}/athletes/${athleteId}/gamelog` +
    (season ? `?season=${season}` : "");
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return { labels: [], events: [], meta: new Map() };
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
    const meta = new Map<string, EspnEventMeta>();
    const rawEvents = (data.events ?? {}) as Record<string, {
      gameDate?: string;
      atVs?: string;
      opponent?: { abbreviation?: string };
    }>;
    for (const [id, ev] of Object.entries(rawEvents)) {
      meta.set(id, {
        eventId: id,
        gameDate: ev.gameDate,
        opponentAbbr: ev.opponent?.abbreviation,
        atVs: ev.atVs,
      });
    }
    return { labels, events, meta };
  } catch {
    return { labels: [], events: [], meta: new Map() };
  }
}

/**
 * Pull a player's gamelog from ESPN, optionally merging multiple seasons.
 *
 * Why multi-season: WNBA regular seasons are short (40 games), so early in
 * the year (when 2026 has 3 games logged) we'd refuse to model anyone — the
 * `buildResult` 5-game floor would trip. By pulling last season too we get
 * 40-60 games of foundation; the downstream "recent form" adjustment is
 * still responsible for tracking the player's CURRENT trend, so adding old
 * games anchors the mean without freezing it to last year's role.
 *
 * Events from later seasons are emitted last so any caller that takes a tail
 * slice (`events.slice(-N)`) for "recent N" naturally gets the newest games.
 */
export async function espnGameLog(
  athleteId: number,
  league: "nba" | "wnba",
  opts?: { seasons?: number[] },
): Promise<{
  labels: string[];
  events: EspnGamelogEvent[];
  /** propId → opponent abbr + game date, used for vs-opponent + recent form adjustments */
  meta: Map<string, EspnEventMeta>;
}> {
  // Default: ESPN's current season only — preserves the old single-call
  // behavior for callers that don't opt in to multi-season training.
  const seasons = opts?.seasons;
  if (!seasons || seasons.length === 0) {
    return fetchSingleSeasonGamelog(athleteId, league);
  }
  // Fire all season requests in parallel. We sort by season ascending so the
  // merged events list runs oldest → newest, which makes downstream
  // "last N games" logic correct out of the box.
  const ordered = [...seasons].sort((a, b) => a - b);
  const seasonResults = await Promise.all(
    ordered.map((s) => fetchSingleSeasonGamelog(athleteId, league, s)),
  );
  // Stat-column labels are stable across seasons for the same league; take
  // whichever non-empty list shows up first.
  const labels = seasonResults.find((r) => r.labels.length > 0)?.labels ?? [];
  const events: EspnGamelogEvent[] = [];
  const meta = new Map<string, EspnEventMeta>();
  const seenIds = new Set<string>();
  for (const r of seasonResults) {
    for (const e of r.events) {
      if (seenIds.has(e.eventId)) continue;
      seenIds.add(e.eventId);
      events.push(e);
    }
    for (const [k, v] of r.meta) meta.set(k, v);
  }
  return { labels, events, meta };
}

// ───────────────────────────────────────────────────────────────────────
// ESPN per-season averages — used for OREB/DREB which aren't in the gamelog.
// The /athletes/{id}/stats endpoint returns season-average rows with labels
// including 'OR' (offensive rebounds per game) and 'DR' (defensive per game).
// We pull the most-recent season's OR / DR / REB averages and use them to
// derive per-game distributions from the gamelog's total-REB values.
// ───────────────────────────────────────────────────────────────────────

interface EspnSeasonStatRow {
  teamSlug?: string;
  season?: { year?: number; displayName?: string };
  stats?: string[];
  position?: string;
}

interface EspnSeasonStatCategory {
  displayName?: string;
  labels?: string[];
  statistics?: EspnSeasonStatRow[];
}

interface EspnSeasonStatsResponse {
  categories?: EspnSeasonStatCategory[];
}

/**
 * Pull current-season OR/DR/REB per-game averages for a player.
 * Returns null if not available or if REB is zero (avoid div-by-zero).
 */
async function fetchEspnSeasonRebSplit(
  athleteId: number,
  league: "nba" | "wnba",
): Promise<{ orPerGame: number; drPerGame: number; rebPerGame: number } | null> {
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/${league}/athletes/${athleteId}/stats`;
  try {
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = (await res.json()) as EspnSeasonStatsResponse;
    const avgCat = (data.categories ?? []).find(
      (c) => c.displayName === "Regular Season Averages",
    );
    if (!avgCat?.labels || !avgCat.statistics) return null;
    const labels = avgCat.labels;
    const iOR = labels.indexOf("OR");
    const iDR = labels.indexOf("DR");
    const iREB = labels.indexOf("REB");
    if (iOR === -1 || iDR === -1 || iREB === -1) return null;
    // Pick the most recent season's row. ESPN gives one row per (team, season),
    // so a mid-season trade can produce two rows for the same year — we just
    // take whichever has the highest year, ties broken by appearance order.
    let best: EspnSeasonStatRow | null = null;
    for (const r of avgCat.statistics) {
      if (!r.stats || r.stats.length <= iREB) continue;
      const year = r.season?.year ?? 0;
      if (!best || year > (best.season?.year ?? 0)) best = r;
    }
    if (!best?.stats) return null;
    const orPerGame = parseFloat(best.stats[iOR]);
    const drPerGame = parseFloat(best.stats[iDR]);
    const rebPerGame = parseFloat(best.stats[iREB]);
    if (
      !Number.isFinite(orPerGame) ||
      !Number.isFinite(drPerGame) ||
      !Number.isFinite(rebPerGame) ||
      rebPerGame <= 0
    ) {
      return null;
    }
    return { orPerGame, drPerGame, rebPerGame };
  } catch {
    return null;
  }
}

/**
 * Segment fraction — what share of a full game does this PrizePicks segment cover?
 *   NBA 1Q  → 25% of game time
 *   NBA 1H/2H → 50% of game time
 *   WNBA same structure
 *   NBA full game → 100%
 *
 * Used to scale ESPN's full-game per-game averages down to the segment so a
 * "NBA1Q Points 8.5" line is compared against the player's 1Q-scaled mean,
 * not their full-game mean. Without this, full-game averages would over-project
 * a quarter line by 4× and force PP-default fallback.
 */
function segmentFractionOf(sport: string): number {
  const s = sport.toUpperCase();
  if (s.endsWith("1Q") || s.endsWith("2Q") || s.endsWith("3Q") || s.endsWith("4Q")) return 0.25;
  if (s.endsWith("1H") || s.endsWith("2H")) return 0.5;
  return 1.0;
}

export async function nbaProjection(prop: Prop): Promise<ProjectionResult> {
  if (prop.isCombo) return { available: false, reason: "Combo prop — skipped" };

  const sport = prop.sport.toUpperCase();
  const league: "nba" | "wnba" = sport.startsWith("WNBA") ? "wnba" : "nba";
  const frac = segmentFractionOf(sport);

  const athleteId = await espnFindAthleteId(prop.playerName, league);
  if (!athleteId) {
    return { available: false, reason: `Player "${prop.playerName}" not found in ESPN ${league.toUpperCase()}` };
  }

  // ── Special path: OREB / DREB ──
  // ESPN gamelog only carries total REB. We use the season-average OR/DR split
  // to derive an OR or DR ratio, then scale each gamelog's total-REB value by
  // that ratio. That preserves real per-game variance (sigma) while anchoring
  // the mean to the player's true OR/DR rate — Allen averages ~3.5 OR/game so
  // a 2.5 OR line should land near 75-80% MORE, not the 50% PrizePicks implied.
  const isOreb = prop.statType === "Offensive Rebounds";
  const isDreb = prop.statType === "Defensive Rebounds";
  if (isOreb || isDreb) {
    const split = await fetchEspnSeasonRebSplit(athleteId, league);
    if (!split) {
      return { available: false, reason: `No season rebound split available for ${prop.playerName}` };
    }
    const { labels, events } = await espnGameLog(athleteId, league, {
      seasons: trainingSeasonsFor(league),
    });
    if (events.length === 0) {
      return { available: false, reason: "ESPN returned no games for this player" };
    }
    const rebValues = events
      .map((e) => extractByLabel(e.stats, labels, "REB"))
      .filter((v) => Number.isFinite(v) && v >= 0);
    if (rebValues.length < 5) {
      return { available: false, reason: `Only ${rebValues.length} games — need at least 5` };
    }
    const ratio = (isOreb ? split.orPerGame : split.drPerGame) / split.rebPerGame;
    const seasonMean = isOreb ? split.orPerGame : split.drPerGame;
    // Scale each total-REB game by the OR (or DR) ratio to get a per-game
    // OR/DR estimate. Variance from this scaled series is accurate, but the
    // mean may drift if the gamelog spans multiple seasons. We anchor the
    // mean to the current season's true OR/DR average — the variance shape
    // is what we want; the location should match this season.
    const scaled = rebValues.map((v) => v * ratio);
    const scaledMean = scaled.reduce((a, b) => a + b, 0) / scaled.length;
    const shift = seasonMean - scaledMean;
    const anchored = scaled.map((v) => Math.max(0, v + shift));
    // Apply segment fraction last (1Q OREB lines compare to a 25%-scaled rebound dist)
    const segScaled = frac < 1 ? anchored.map((v) => v * frac) : anchored;
    const labelText = isOreb ? "OREB" : "DREB";
    const segNote = frac < 1 ? ` · scaled to ${(frac * 100).toFixed(0)}% (${sport})` : "";
    return buildResult(
      segScaled,
      prop.line,
      `ESPN ${league.toUpperCase()} · ${prop.playerName} (${labelText} avg ${seasonMean.toFixed(1)}, ${(ratio * 100).toFixed(0)}% of REB)${segNote}`,
      `${league}-espn-${isOreb ? "oreb" : "dreb"}-v1${frac < 1 ? `-${sport.toLowerCase()}` : ""}`,
    );
  }

  const extractor = ESPN_BASKETBALL_STATS[prop.statType];
  if (!extractor) {
    return { available: false, reason: `No mapping for stat type "${prop.statType}"` };
  }

  const { labels, events, meta } = await espnGameLog(athleteId, league, {
    seasons: trainingSeasonsFor(league),
  });
  if (events.length === 0) {
    return { available: false, reason: "ESPN returned no games for this player" };
  }

  // Build values + parallel arrays for adjustment signals.
  // We pull opponent, date, AND atVs (home/away marker) from the gamelog so
  // the home/away + days-rest signals downstream can read them.
  const chronoValues: number[] = [];
  const minutesArr: number[] = [];
  const opponents: (string | undefined)[] = [];
  const dates: (string | undefined)[] = [];
  const atVsArr: (string | undefined)[] = [];
  for (const e of events) {
    let v = extractor(e.stats, labels);
    if (!Number.isFinite(v) || v < 0) continue;
    // Segment scaling — for NBA1Q the player's full-game 32 PTS is multiplied
    // by 0.25 to estimate their 1Q output (~8 PTS). NBA1H × 0.5, etc. Std
    // scales by the same factor (slight under-estimate of true 1Q std since
    // within-game minutes vary, but vastly better than the implied 50%).
    if (frac < 1) v = v * frac;
    chronoValues.push(v);
    minutesArr.push(extractByLabel(e.stats, labels, "MIN"));
    const m = meta.get(e.eventId);
    opponents.push(m?.opponentAbbr);
    dates.push(m?.gameDate);
    atVsArr.push(m?.atVs);
  }
  // Sort chronologically (oldest → newest) so recent-form / days-rest signals see the right order
  const sortable = chronoValues.map((v, i) => ({
    v, opp: opponents[i], d: dates[i], hv: atVsArr[i], mn: minutesArr[i],
  }));
  sortable.sort((a, b) => (a.d ?? "").localeCompare(b.d ?? ""));
  const sortedValues = sortable.map((s) => s.v);
  const sortedOpps = sortable.map((s) => s.opp);
  const sortedDates = sortable.map((s) => s.d);
  const sortedAtVs = sortable.map((s) => s.hv);
  const sortedMins = sortable.map((s) => s.mn);

  // Was the player HOME in this prop's game? We compute this server-side in
  // /api/props from the PrizePicks game-info block (home/away team
  // abbreviations matched against the player's team), so prop.isHome is
  // already set when we can be confident. If undefined (cross-sport or no
  // matchup data), the home/away signal simply doesn't fire.
  const propIsHome: boolean | undefined = prop.isHome;

  const segNote = frac < 1 ? ` · scaled to ${(frac * 100).toFixed(0)}% (${sport})` : "";
  const baseline = buildResult(
    sortedValues,
    prop.line,
    `ESPN ${league.toUpperCase()} · ${prop.playerName}${segNote}`,
    `${league}-espn-v1${frac < 1 ? `-${sport.toLowerCase()}` : ""}`,
  );
  if (!baseline.available) return baseline;
  // narrow to the available branch so applyAdjustments accepts it
  const available = baseline as RealProjection & { available: true };
  return applyAdjustments(available, prop.line, {
    chronoValues: sortedValues,
    opponents: sortedOpps,
    atVs: sortedAtVs,
    dates: sortedDates,
    propOpponent: prop.opponent,
    propIsHome,
    propGameTime: prop.gameTime,
    propStat: prop.statType,
    playerName: prop.playerName,
    propTeam: prop.team,
    minutes: sortedMins,
    intelSwing: prop.intelSwing,
    intelEvidence: prop.intelEvidence,
  });
}

// ════════════════════════════════════════════════════════════════════
// Router — pick the right source for a prop
// ════════════════════════════════════════════════════════════════════

export async function projectionFor(prop: Prop): Promise<ProjectionResult> {
  // Ensure registry is populated (idempotent — only the first call does work)
  await import("@/lib/sports/registerAll");
  const { getAdapterFor } = await import("@/lib/sports/registry");
  const { loadArtifactsForSport } = await import("@/lib/sports/artifactCache");

  // Warm caches up front so the NBA/WNBA sync accessors hit. The adapter's
  // project() delegates to nbaProjection/mlbProjection which read from these.
  await Promise.all([
    getDefenseRatings(),
    getCalibration(),
    getPlayoffCalibration(),
    getRound2Teams(),
    getBreakoutProfiles(),
    getGameScript(),
  ]);

  const adapter = getAdapterFor(prop.sport.toUpperCase());
  let result: ProjectionResult;
  if (adapter) {
    const artifacts = await loadArtifactsForSport(adapter.leagues[0].toLowerCase());
    result = await adapter.project(prop, artifacts);
  } else {
    result = {
      available: false,
      reason: `No real model for ${prop.sport} yet — using PrizePicks's default chance.`,
    };
  }

  // Kalshi blend — runs alongside ESPN. Coverage is narrow (Points/Assists/3PT
  // for NBA/WNBA today) but when a market matches, it gives an independent
  // probability signal. Behavior depends on whether ESPN has a usable answer:
  //   - ESPN unavailable + Kalshi available → use Kalshi standalone
  //   - Both available → inverse-variance blend, recorded as an adjustment
  //   - Neither → return whatever we had
  result = await maybeBlendKalshi(prop, result);
  return result;
}

/**
 * Optionally enrich a projection result with a Kalshi market-implied signal.
 *
 * Safe to call for any prop — returns the input unchanged if (sport, statType)
 * isn't in Kalshi's coverage map or no matching market has a usable quote.
 *
 * Kalshi's threshold semantics ("Player: 13+") map directly to PrizePicks's
 * line semantics for `Number.isInteger(line) ? line+1 : ceil(line)`, which is
 * what `kalshiSignalFor` already evaluated at. So `signal.pYes` IS pMore.
 */
async function maybeBlendKalshi(prop: Prop, result: ProjectionResult): Promise<ProjectionResult> {
  let signal: KalshiSignal | null;
  try {
    signal = await kalshiSignalFor(prop);
  } catch {
    return result;
  }
  if (!signal) return result;

  if (!result.available) {
    // Kalshi-only path: fabricate a minimal RealProjection. We don't have a
    // gamelog mean here, so we leave `projection` at the line itself and
    // express our uncertainty via a synthetic sigma. The badge will render
    // off pMore/pLess as normal.
    const pMore = signal.pYes;
    const pMoreClamped = Math.max(C.pMoreClampLow, Math.min(C.pMoreClampHigh, pMore));
    return {
      available: true,
      pMore: r3(pMoreClamped),
      pLess: r3(1 - pMoreClamped),
      // Without a gamelog mean we report the line as a placeholder. Spread is
      // the only uncertainty signal Kalshi gives us, so scale it to roughly
      // match the typical sigma range (~1–6 for basketball stats).
      projection: r3(prop.line),
      sigma: r3(Math.max(0.5, signal.spread * 10)),
      sampleSize: 0,
      recent: [],
      source: `Kalshi market · ${signal.marketTicker.split("+")[0]}`,
      modelVersion: "kalshi-only-v1",
      baselineProjection: r3(prop.line),
      baselinePMore: r3(pMoreClamped),
      adjustments: [
        {
          label: "Kalshi market",
          shift: 0,
          pMoreSwing: 0,
          confidence: signal.confidence,
          reason: `Kalshi bid/ask midpoint at ${signal.threshold}+ (spread ${(signal.spread * 100).toFixed(0)}¢) — no ESPN gamelog model available, using market consensus alone.`,
        },
      ],
    };
  }

  // Both available — inverse-variance-ish blend. Trust the ESPN side more
  // when its sample is large; trust Kalshi more when the spread is tight.
  const espnConfidence = Math.min(1, result.sampleSize / 10);
  const { pMore: blendedPMore, kalshiWeight } = blendPMore(result.pMore, espnConfidence, signal);
  const pMoreBefore = result.pMore;
  const pMoreClamped = Math.max(C.pMoreClampLow, Math.min(C.pMoreClampHigh, blendedPMore));
  const swing = pMoreClamped - pMoreBefore;
  return {
    ...result,
    pMore: r3(pMoreClamped),
    pLess: r3(1 - pMoreClamped),
    source: `${result.source} + Kalshi`,
    adjustments: [
      ...(result.adjustments ?? []),
      {
        label: "Kalshi market",
        shift: 0,
        pMoreSwing: r3(swing),
        confidence: signal.confidence,
        reason: `Kalshi ${signal.marketTicker.split("+")[0]} implies P(More) ≈ ${(signal.pYes * 100).toFixed(0)}% at ${signal.threshold}+ (spread ${(signal.spread * 100).toFixed(0)}¢); blended at ${(kalshiWeight * 100).toFixed(0)}% weight.`,
      },
    ],
  };
}

/**
 * Route the chosen-side probability through the trained isotonic corrector.
 * The backtest was fit on `chosenProb → calibratedChosenProb` for the side
 * the model preferred (always ≥ 0.5), so live application must mirror that:
 * calibrate whichever of pMore/pLess is the model's preferred side, then
 * derive the other as `1 − corrected`.
 *
 * No-ops if `calibration.json` doesn't exist or the kill-switch
 * `DISABLE_CALIBRATION=1` is set.
 */
export async function applyCalibrationToResult(
  result: ProjectionResult,
  oddsType: OddsTypeKey | undefined,
  stat?: string,
  gameTime?: string,
  team?: string,
): Promise<ProjectionResult> {
  if (!result.available) return result;
  const baseModel = await getCalibration();
  if (!baseModel) return result;
  const preferMore = result.pMore >= result.pLess;
  const chosen = preferMore ? result.pMore : result.pLess;

  // Stage 1 — base per-stat × per-oddsType calibration.
  let corrected = await calibrate(chosen, oddsType, stat);

  // Stage 2 — playoff overlay. Two conditions: (a) target game is in the
  // playoff window, (b) the player's team is in the trained round-2 set.
  // The overlay was fit on round-2-team postseason data; applying it to
  // play-in games or non-round-2 teams would extrapolate the curve.
  const inPlayoff = !!gameTime && isPlayoffDate(gameTime);
  const teamIsRound2 = isRound2TeamSync(team);
  let playoffApplied = false;
  if (inPlayoff && teamIsRound2) {
    const overlay = await getPlayoffCalibration();
    if (overlay && overlay.breakpoints.length > 0) {
      const after = applyPlayoffCalibrationSync(corrected);
      if (Math.abs(after - corrected) > 1e-6) {
        corrected = after;
        playoffApplied = true;
      }
    }
  }

  if (Math.abs(corrected - chosen) < 1e-6) return result;

  const rawCalPMore = preferMore ? corrected : 1 - corrected;
  // Guardrail: a sane isotonic correction NUDGES the probability; it should not
  // flip a coinflip into a near-lock. Overfit/sparse per-(stat × oddsType)
  // curves can map ~0.50 → ~0.95 (observed: WNBA Rebs+Asts), which then
  // contradicts a projection mean sitting right on the line. Clamp the swing to
  // ±0.20 so the directional correction survives but the absurd over-confidence
  // (and the mean-vs-probability contradiction it creates) cannot.
  const MAX_CAL_SWING = 0.2;
  const rawSwing = rawCalPMore - result.pMore;
  const swing = Math.max(-MAX_CAL_SWING, Math.min(MAX_CAL_SWING, rawSwing));
  const calPMore = Math.max(0.02, Math.min(0.98, result.pMore + swing));
  const calPLess = 1 - calPMore;
  const calibrationAdjustment: ProjectionAdjustment = {
    label: playoffApplied ? "Calibration (playoff layered)" : "Calibration",
    shift: 0,
    pMoreSwing: r3(swing),
    reason: playoffApplied
      ? `Base isotonic corrector (${stat ?? "any-stat"} · ${oddsType ?? "all"}) plus playoff-only ` +
        `overlay (round-2 teams, 2025-26 postseason). Raw model corrected to match observed ` +
        `playoff hit rate.`
      : `Isotonic corrector (${stat ?? "any-stat"} · ${oddsType ?? "all"}) trained on 2025-26 season — ` +
        `raw model is overconfident; corrected to match observed hit rate.`,
    confidence: 1,
  };
  const versionSuffix = playoffApplied ? "+iso+playoff" : "+iso";
  return {
    ...result,
    pMore: r3(calPMore),
    pLess: r3(calPLess),
    adjustments: [...(result.adjustments ?? []), calibrationAdjustment],
    modelVersion: result.modelVersion.includes(versionSuffix)
      ? result.modelVersion
      : `${result.modelVersion}${versionSuffix}`,
  };
}
