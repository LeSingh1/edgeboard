"use client";

import { Flame, Leaf } from "lucide-react";
import type { OddsType } from "@/lib/types";

interface OddsBadgeProps {
  oddsType: OddsType;
  compact?: boolean;
}

/**
 * Visual indicator for PrizePicks' odds_type modifier.
 *
 *   demon  → flame icon, red/orange, "×1.25" payout label
 *   goblin → leaf icon, green, "×0.85" payout label
 *   standard → no badge (default state)
 */
export function OddsBadge({ oddsType, compact = false }: OddsBadgeProps) {
  if (oddsType === "standard") return null;

  if (oddsType === "demon") {
    return (
      <span
        title="Demon — harder line, payout × 1.25"
        className={
          "inline-flex items-center gap-1 rounded-full border-2 bg-[#FF6B35]/15 border-[#FF6B35] text-[#FF6B35] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest " +
          (compact ? "px-1.5 py-0 text-[8px]" : "px-2 py-0.5 text-[9px]")
        }
      >
        <Flame size={compact ? 8 : 10} strokeWidth={3} fill="#FF6B35" />
        Demon ×1.25
      </span>
    );
  }

  // goblin
  return (
    <span
      title="Goblin — easier line, payout × 0.85"
      className={
        "inline-flex items-center gap-1 rounded-full border-2 bg-[#4ADE80]/15 border-[#4ADE80] text-[#4ADE80] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest " +
        (compact ? "px-1.5 py-0 text-[8px]" : "px-2 py-0.5 text-[9px]")
      }
    >
      <Leaf size={compact ? 8 : 10} strokeWidth={3} fill="#4ADE80" />
      Goblin ×0.85
    </span>
  );
}
