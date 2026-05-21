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

export function impliedProbability(oddsType: OddsType): {
  pMore: number;
  pLess: number;
  modelVersion: string;
} {
  const pMore = IMPLIED_MORE[oddsType] ?? 0.5;
  return {
    pMore: round3(pMore),
    pLess: round3(1 - pMore),
    modelVersion: "implied-v1",
  };
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
