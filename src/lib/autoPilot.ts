/**
 * Auto-Pilot lineup builder.
 *
 * The Optimizer page needs the user to first hand-pick props onto the bench.
 * Auto-Pilot collapses that: given the entire live board, pick the highest-
 * probability props automatically and run the same optimizer on the resulting
 * pool. The output is N "best chance to cash" lineups the user can play
 * straight away.
 *
 * Probability source:
 *   - When a real projection is cached in `realProjections` (because the user
 *     has visited the live board for that prop), we use it.
 *   - Otherwise we fall back to PrizePicks-implied. Implied math favors
 *     goblins (pMore ≈ 0.588) heavily — so unseeded runs lean goblin-heavy.
 *
 * Search-space discipline:
 *   - One pick per family (we choose the variant whose best side has the
 *     highest probability before handing to the optimizer).
 *   - Pool is capped by lineup size — C(pool, k) × 2^k grows fast; the caps
 *     keep a 6-pick generation under ~10M evaluations.
 *   - We pass NO variant table to the optimizer, so it doesn't re-explore
 *     goblin/std/demon swaps; the per-family choice we made above is final.
 */

import { groupByFamily, familyKeyOf, type VariantSet } from "@/lib/variantGroups";
import { optimize } from "@/lib/optimizer";
import type { Lineup, PickSide, Prop } from "@/lib/types";
import type { ProjectionResult } from "@/lib/realProjections";

export interface AutoPilotOptions {
  /** League name from the props feed, or "ALL" / undefined for no filter. */
  sport?: string;
  /** Hard cap on the candidate pool. If omitted, picked from `poolCapFor(lineupSize)`. */
  maxPoolSize?: number;
  /** Drop props whose best side falls below this probability. Default 0.50. */
  minProbability?: number;
  /** Drop currently-live games (they can lock mid-sort). Default true. */
  excludeLive?: boolean;
  /** Drop combo / multi-player props. Default true. */
  excludeCombo?: boolean;
  /** Cached real projections (from useProjectionStore). When a prop has one,
   *  we use it in place of the implied probability. */
  realProjections?: Record<string, ProjectionResult>;
  /** When true, prefer lineups that share fewer picks (up to ~70% overlap).
   *  Defaults to true — the user is asking for multiple lineups, they
   *  probably want some variety, not 5 near-identical slips. */
  diversify?: boolean;
}

export interface AutoPilotResult {
  /** The candidate pool fed to the optimizer (already family-deduped + variant-resolved). */
  candidates: Prop[];
  lineups: Lineup[];
  poolSize: number;
  totalEvaluated: number;
  elapsedMs: number;
  /** How many candidates in the pool had a real projection backing their probability. */
  realProjectionCount: number;
}

/**
 * Compute-budget caps. C(n, k) × 2^k roughly grows by ~16× per increment in k,
 * so we shrink the pool as lineup size grows. These caps keep the worst case
 * under ~10M evaluations on a generation, well inside one frame in the browser.
 */
function poolCapFor(lineupSize: number): number {
  if (lineupSize <= 2) return 36;
  if (lineupSize === 3) return 28;
  if (lineupSize === 4) return 22;
  if (lineupSize === 5) return 18;
  return 14; // 6-pick
}

/** Patch implied probabilities with a real projection when one exists. */
function withRealProb(p: Prop, real?: Record<string, ProjectionResult>): Prop {
  const r = real?.[p.id];
  if (r && r.available) {
    return { ...p, pMore: r.pMore, pLess: r.pLess, modelVersion: r.modelVersion };
  }
  return p;
}

/**
 * Across goblin / standard / demon for one family, pick the variant whose
 * better side has the highest probability. demon/goblin are MORE-only on
 * PrizePicks, so for those we read pMore directly; for standard we take the
 * max of either side.
 */
function bestVariant(
  vs: VariantSet,
  real?: Record<string, ProjectionResult>,
): { prop: Prop; side: PickSide; prob: number } | null {
  const all = [vs.goblin, vs.standard, vs.demon].filter(Boolean) as Prop[];
  if (all.length === 0) return null;

  let best: { prop: Prop; side: PickSide; prob: number } | null = null;
  for (const raw of all) {
    const p = withRealProb(raw, real);
    const candidate: { prop: Prop; side: PickSide; prob: number } =
      p.oddsType !== "standard"
        ? { prop: p, side: "more", prob: p.pMore }
        : p.pMore >= p.pLess
          ? { prop: p, side: "more", prob: p.pMore }
          : { prop: p, side: "less", prob: p.pLess };
    if (!best || candidate.prob > best.prob) best = candidate;
  }
  return best;
}

/**
 * Greedy diversity filter — keeps the top-ranked lineup, then walks the rest
 * skipping any lineup that shares more than ~70% of its picks with one
 * already selected. If diversity leaves us short of `k`, the leftovers are
 * appended in rank order (so we always return as many as requested if the
 * optimizer found that many).
 */
function selectDiverse(lineups: Lineup[], k: number, size: number): Lineup[] {
  if (lineups.length === 0 || k <= 0) return [];
  const maxShared = Math.max(1, Math.floor(size * 0.7));
  const out: Lineup[] = [lineups[0]];
  const used = new Set<string>([lineups[0].id]);
  for (const l of lineups.slice(1)) {
    if (out.length >= k) break;
    const lIds = new Set(l.picks.map((p) => p.prop.id));
    const tooSimilar = out.some((existing) => {
      let shared = 0;
      for (const p of existing.picks) if (lIds.has(p.prop.id)) shared++;
      return shared > maxShared;
    });
    if (tooSimilar) continue;
    out.push(l);
    used.add(l.id);
  }
  if (out.length < k) {
    for (const l of lineups) {
      if (out.length >= k) break;
      if (used.has(l.id)) continue;
      out.push(l);
      used.add(l.id);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
// Natural-language request parser
//
// The chat input on /auto-pilot funnels free-text requests through
// parseRequest(). It extracts whatever knobs were named — count, size,
// entry, sport, risk mode — and leaves the rest undefined so the page
// can fall back to Auto for them.
//
// We DON'T try to be a general LLM. We pattern-match the things
// PrizePicks users actually say: "give me 3 lineups", "I have $20",
// "safe play", "NBA only", "5-pick to win big". Anything we can't
// match silently falls through to defaults, which gives the same
// behavior as hitting Surprise Me.
// ════════════════════════════════════════════════════════════════════

export type RiskIntent = "safe" | "balanced" | "aggressive";

export interface ParsedRequest {
  count?: number;
  size?: number;
  entry?: number;
  /** Sport league name, matched against `knownSports` case-insensitively. */
  sport?: string;
  /** Risk preference inferred from words like "safe", "easy", "risky". */
  mode?: RiskIntent;
  /** Phrases that should clear everything back to Auto. */
  resetAll?: boolean;
  /** Which fields we actually matched — drives the assistant's reply copy
   *  ("Going with 3 slips · $5 · all sports") so it doesn't claim to have
   *  understood things the user never said. */
  matched: Array<"count" | "size" | "entry" | "sport" | "mode" | "resetAll">;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  a: 1, an: 1, single: 1, just: 1,
};

function wordToNumber(s: string): number | null {
  const lower = s.toLowerCase();
  if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower];
  const n = parseInt(lower, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseRequest(text: string, knownSports: string[] = []): ParsedRequest {
  const lower = text.toLowerCase();
  const out: ParsedRequest = { matched: [] };

  // "surprise me" / "anything" / "auto" → reset everything
  if (/\b(surprise me|anything works|whatever you want|just pick|all auto|auto pick)\b/i.test(text)) {
    out.resetAll = true;
    out.matched.push("resetAll");
  }

  // Risk intent — favor safer / bigger payouts based on language
  if (/\b(safe|safer|easy|easily|guaranteed|sure thing|locks?|low risk|conservative)\b/i.test(text)) {
    out.mode = "safe";
    out.matched.push("mode");
  } else if (/\b(aggressive|risky|high payout|big payout|long shot|moonshot|swing|big money)\b/i.test(text)) {
    out.mode = "aggressive";
    out.matched.push("mode");
  } else if (/\b(balanced|middle|mix)\b/i.test(text)) {
    out.mode = "balanced";
    out.matched.push("mode");
  }

  // Number of lineups — "give me 3 lineups", "3 slips", "two plays", "best lineup"
  const countWithUnit = lower.match(/\b(one|two|three|four|five|\d+)\s+(?:lineups?|slips?|plays?|parlays?|bets?)\b/);
  const bestSingular = /\b(?:the\s+)?best\s+(?:lineup|slip|play|parlay|bet)\b/i.test(text);
  const giveMeOne = lower.match(/\b(?:give me|build me|make me|get me|i want|gimme|show me)\s+(one|two|three|four|five|\d+)\b/);
  if (countWithUnit) {
    const v = wordToNumber(countWithUnit[1]);
    if (v != null && v >= 1 && v <= 10) {
      out.count = Math.min(5, v);
      out.matched.push("count");
    }
  } else if (bestSingular) {
    out.count = 1;
    out.matched.push("count");
  } else if (giveMeOne) {
    const v = wordToNumber(giveMeOne[1]);
    if (v != null && v >= 1 && v <= 5) {
      out.count = v;
      out.matched.push("count");
    }
  }

  // Picks per lineup — "4-pick", "5 pick", "size 4", "with 6 picks"
  const sizeMatch =
    lower.match(/\b(2|3|4|5|6)[\s-]?pick\b/) ??
    lower.match(/\bsize\s*(2|3|4|5|6)\b/) ??
    lower.match(/\bwith\s+(2|3|4|5|6)\s+picks?\b/);
  if (sizeMatch) {
    out.size = parseInt(sizeMatch[1], 10);
    out.matched.push("size");
  }

  // Entry cost — "$20", "I have 5", "for $50", "20 dollars", "ten bucks"
  const dollarMatch = lower.match(/\$\s*(\d{1,4})\b/);
  const haveMatch = lower.match(/\b(?:i have|with|for|spend|using|budget(?: of)?|got)\s+\$?\s*(\d{1,4})(?:\s*(?:dollars|bucks|dollar|buck))?\b/);
  const wordsMatch = lower.match(/\b(\d{1,4})\s*(?:dollars|bucks|dollar|buck)\b/);
  const entryRaw = dollarMatch?.[1] ?? haveMatch?.[1] ?? wordsMatch?.[1];
  if (entryRaw) {
    const v = parseInt(entryRaw, 10);
    if (v >= 1 && v <= 1000) {
      out.entry = v;
      out.matched.push("entry");
    }
  }

  // Sport — try every league name from the live board against the text.
  // Word boundary on both sides so "MLS" doesn't match "MLSports" or whatever.
  if (/\b(all\s+sports|every\s+sport|any\s+sport|across\s+all)\b/i.test(text)) {
    // Explicit "across all sports" → leave sport undefined so it falls back
    // to ALL/auto on the page. No matched entry — defaults handle it.
  } else {
    for (const s of knownSports) {
      if (!s || s === "ALL") continue;
      const re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(text)) {
        out.sport = s;
        out.matched.push("sport");
        break;
      }
    }
  }

  return out;
}

/**
 * Letter grade for the top lineup, based purely on its hit probability.
 * The /auto-pilot chat shows this next to the assistant's reply so the
 * user has a one-glance read on "how confident is this pick really?".
 *
 *   A → ≥ 40% chance      (rare with PrizePicks-implied odds)
 *   B → ≥ 25%
 *   C → ≥ 15%
 *   D → ≥ 8%
 *   F → < 8%
 */
export function gradeLineup(hitProbability: number): "A" | "B" | "C" | "D" | "F" {
  if (hitProbability >= 0.40) return "A";
  if (hitProbability >= 0.25) return "B";
  if (hitProbability >= 0.15) return "C";
  if (hitProbability >= 0.08) return "D";
  return "F";
}

export const GRADE_COLOR: Record<ReturnType<typeof gradeLineup>, string> = {
  A: "#4ADE80",
  B: "#A3E635",
  C: "#FFE600",
  D: "#FF6B35",
  F: "#F87171",
};

/**
 * Sweep lineup sizes 2..6 with a small pool and pick the one whose top
 * lineup has the highest expected dollars ($-payout × hit-prob). Used by
 * the page when the user leaves "picks per lineup" on Auto.
 *
 * Each size is fast (the optimizer caps the pool per `poolCapFor`), so the
 * whole sweep finishes in well under a second on a typical board.
 */
export function pickAutoSize(
  allProps: Prop[],
  options: AutoPilotOptions = {},
): number {
  let bestSize = 4;
  let bestScore = -Infinity;
  for (const size of [2, 3, 4, 5, 6]) {
    const r = buildAutoLineups(allProps, size, 1, 20, { ...options, diversify: false });
    const top = r.lineups[0];
    if (!top) continue;
    // Expected gross dollars at $20 entry. Picks the size with the highest
    // long-run $-per-slip — naturally smaller for thin boards (less variance),
    // larger when there's enough material to support a big multiplier.
    const score = top.hitProbability * top.grossPayout - 20;
    if (score > bestScore) {
      bestScore = score;
      bestSize = size;
    }
  }
  return bestSize;
}

/**
 * Score → top pool → optimize → diversity → return top K. See module header
 * for tradeoffs.
 */
export function buildAutoLineups(
  allProps: Prop[],
  lineupSize: number,
  lineupCount: number,
  entryCost: number,
  options: AutoPilotOptions = {},
): AutoPilotResult {
  const start = performance.now();
  const real = options.realProjections;
  const families = groupByFamily(allProps);

  const seen = new Set<string>();
  const candidates: Array<{ prop: Prop; side: PickSide; prob: number }> = [];

  for (const p of allProps) {
    if (options.sport && options.sport !== "ALL" && p.sport !== options.sport) continue;
    if ((options.excludeLive ?? true) && p.isLive) continue;
    if ((options.excludeCombo ?? true) && p.isCombo) continue;

    const fk = familyKeyOf(p);
    if (seen.has(fk)) continue;
    seen.add(fk);

    const vs = families.get(fk);
    if (!vs) continue;

    const best = bestVariant(vs, real);
    if (!best) continue;
    const minProb = options.minProbability ?? 0.5;
    if (best.prob < minProb) continue;

    candidates.push(best);
  }

  candidates.sort((a, b) => b.prob - a.prob);
  const cap = options.maxPoolSize ?? poolCapFor(lineupSize);
  const pool = candidates.slice(0, cap);
  const poolProps = pool.map((c) => c.prop);

  const realProjectionCount = real
    ? poolProps.filter((p) => real[p.id]?.available).length
    : 0;

  if (poolProps.length < lineupSize) {
    return {
      candidates: poolProps,
      lineups: [],
      poolSize: poolProps.length,
      totalEvaluated: 0,
      elapsedMs: Math.round(performance.now() - start),
      realProjectionCount,
    };
  }

  // No variantsByPropId → optimizer won't explore variant swaps. Side mask
  // enumeration in the optimizer naturally picks the higher-probability side
  // for each standard pick, which is exactly what we want for "safest" mode.
  const r = optimize({
    selectedProps: poolProps,
    lineupSize,
    entryCost,
    riskMode: "safe",
    maxResults: Math.max(lineupCount * 6, 60),
  });

  const picked = (options.diversify ?? true)
    ? selectDiverse(r.lineups, lineupCount, lineupSize).map((l, i) => ({ ...l, rank: i + 1 }))
    : r.lineups.slice(0, lineupCount).map((l, i) => ({ ...l, rank: i + 1 }));

  return {
    candidates: poolProps,
    lineups: picked,
    poolSize: poolProps.length,
    totalEvaluated: r.totalGenerated,
    elapsedMs: Math.round(performance.now() - start),
    realProjectionCount,
  };
}
