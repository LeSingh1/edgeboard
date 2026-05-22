/**
 * Build a plain-English explanation of WHY the optimizer chose particular
 * goblin / demon variants for a lineup. Used to surface variant strategy on
 * the slips leaderboard so the user understands what to actually enter.
 *
 *   Goblin Allen (1.5 line, ~70%) — keeps the 1 weak link safe.
 *   Demon Mitchell (32.5 line, +25% payout) — squeezes the slip's ceiling.
 *   Mixed: 2 goblin + 1 demon + 2 standard — balanced EV.
 */

import type { Lineup } from "@/lib/types";

export interface VariantStrategy {
  /** Short one-line headline shown as a chip */
  summary: string;
  /** Longer explanation shown on hover or in the hero card */
  detail: string;
  goblinCount: number;
  standardCount: number;
  demonCount: number;
}

/** Just the last word of a name, for compact chip text ("Allen" from "Jarrett Allen") */
function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

export function analyzeVariantStrategy(lineup: Lineup): VariantStrategy | null {
  const counts = { goblin: 0, standard: 0, demon: 0 };
  for (const pick of lineup.picks) counts[pick.prop.oddsType]++;

  // Skip when every pick is standard — nothing to call out.
  if (counts.goblin === 0 && counts.demon === 0) return null;

  const goblins = lineup.picks.filter((p) => p.prop.oddsType === "goblin");
  const demons = lineup.picks.filter((p) => p.prop.oddsType === "demon");
  const standards = lineup.picks.filter((p) => p.prop.oddsType === "standard");

  const summarize = (picks: typeof lineup.picks) =>
    picks.map((p) => `${lastName(p.prop.playerName)} ${p.prop.line}`).join(" · ");

  if (counts.goblin > 0 && counts.demon === 0) {
    // Pure goblin-swap strategy
    const players = goblins.map((g) => lastName(g.prop.playerName)).join(" + ");
    const stdCount = counts.standard;
    return {
      summary: `Goblin ${players} — easier line, safer floor`,
      detail:
        `Use the goblin variant on ${summarize(goblins)} — the easier line raises hit prob on the weakest leg. ` +
        (stdCount > 0
          ? `The other ${stdCount} pick${stdCount === 1 ? " stays" : "s stay"} on the standard over/under (${summarize(standards)}). `
          : "") +
        `Trade-off: payout × 0.85 per goblin leg, but ${(goblins[0].probability * 100).toFixed(0)}% per leg vs ~50% on standard.`,
      goblinCount: counts.goblin,
      standardCount: counts.standard,
      demonCount: counts.demon,
    };
  }

  if (counts.demon > 0 && counts.goblin === 0) {
    // Pure demon-stack strategy
    const players = demons.map((d) => lastName(d.prop.playerName)).join(" + ");
    const stdCount = counts.standard;
    return {
      summary: `Demon ${players} — harder line, +25% payout each`,
      detail:
        `Use the demon variant on ${summarize(demons)} — pays × 1.25 per leg for taking the tougher line. ` +
        (stdCount > 0
          ? `Other ${stdCount} pick${stdCount === 1 ? " is" : "s are"} standard (${summarize(standards)}). `
          : "") +
        `Best when the standard line already feels safe and you want to squeeze the payout ceiling.`,
      goblinCount: counts.goblin,
      standardCount: counts.standard,
      demonCount: counts.demon,
    };
  }

  // Mixed goblin + demon
  return {
    summary: `Mixed swap: ${counts.goblin} goblin · ${counts.demon} demon · ${counts.standard} std`,
    detail:
      `Goblin on ${summarize(goblins)} for safety, demon on ${summarize(demons)} for the payout multiplier, ` +
      `${counts.standard} on the true line (${summarize(standards) || "—"}). ` +
      `This is the EV-optimal mix for these picks at this size.`,
    goblinCount: counts.goblin,
    standardCount: counts.standard,
    demonCount: counts.demon,
  };
}
