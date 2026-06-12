import type { OddsType } from "@/lib/types";

/**
 * PrizePicks-implied probability model (v1).
 *
 * PrizePicks does NOT publish player projections. What they DO publish per prop
 * is an `odds_type`: standard, demon, or goblin. Each modifies the line and the
 * payout. The implied hit probability of taking MORE on each is derived from the
 * multiplier they apply:
 *
 *   - standard: line tuned to ~50/50 (their median projection). MORE ≈ 0.500
 *   - demon:    payout × 1.25, so line is pushed harder.       MORE ≈ 0.400
 *   - goblin:   payout × 0.85, so line is pulled easier.       MORE ≈ 0.588
 *
 * Sources:
 *   - PrizePicks Help Center, "Demons & Goblins" (~2024–2026)
 *   - User-side: payout-implied break-even formula 1 / (multiplier × base)
 *
 * These are PrizePicks' implied numbers, not edge — meaning a slip of all
 * standard picks has zero raw edge from this model. Real edge requires a real
 * regression projection (planned in /model-lab via Python worker).
 */

const IMPLIED_MORE: Record<OddsType, number> = {
  standard: 0.500,
  demon:    0.400,  // harder line → MORE less likely
  goblin:   0.588,  // easier line → MORE more likely
};

/** Sentinel modelVersion for the flat PrizePicks-implied placeholder. A prop
 *  carrying this has NO real projection behind it — its pMore/pLess are derived
 *  purely from the odds_type, not from any game data. Treat it as mock. */
export const IMPLIED_MODEL_VERSION = "implied-v1";

/** True iff a real game-log projection priced this prop (any modelVersion other
 *  than the implied placeholder). The one check every pick/edge surface uses to
 *  decide whether a probability is real or mock. */
export function hasRealModel(modelVersion?: string | null): boolean {
  return !!modelVersion && modelVersion !== IMPLIED_MODEL_VERSION;
}

export function impliedProbability(oddsType: OddsType): {
  pMore: number;
  pLess: number;
  modelVersion: string;
} {
  const pMore = IMPLIED_MORE[oddsType] ?? 0.5;
  return {
    pMore: round3(pMore),
    pLess: round3(1 - pMore),
    modelVersion: IMPLIED_MODEL_VERSION,
  };
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
