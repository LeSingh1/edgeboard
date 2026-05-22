"use client";

import { motion } from "framer-motion";
import { ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { variantList, findVariantById, type VariantSet } from "@/lib/variantGroups";
import type { OddsType, Prop } from "@/lib/types";

interface VariantTabsProps {
  variants: VariantSet;
  /** Currently active rung's propId — what the card is showing right now. */
  activePropId: string;
  /** Called when the user clicks the swap button (cycles to next variant). */
  onChange: (newProp: Prop) => void;
  /** Compact = used in bench rows; default = used on board cards */
  compact?: boolean;
}

const LABELS: Record<OddsType, string> = {
  goblin: "Goblin",
  standard: "Standard",
  demon: "Demon",
};

const NEXT_COLOR: Record<OddsType, string> = {
  goblin: "#4ADE80",
  standard: "#FFE600",
  demon: "#FF6B35",
};

/**
 * PrizePicks-faithful variant swap button — a single small ⇄ circle that cycles
 * through the available variants (goblin → standard → demon → goblin). Matches
 * the PrizePicks app: one tappable icon, no pills cluttering the card. Each tap
 * updates the line value (which animates) plus the OddsBadge in the card header.
 *
 * Returns null when there's only one variant in the family.
 */
export function VariantTabs({ variants, activePropId, onChange, compact }: VariantTabsProps) {
  const list = variantList(variants);
  if (list.length < 2) return null;

  // Find which rung we're currently on
  const activeProp = findVariantById(variants, activePropId);
  const activeOddsType: OddsType = activeProp?.oddsType ?? list[0].oddsType;
  const activeIdx = list.findIndex((v) => v.oddsType === activeOddsType);
  const currentIdx = activeIdx === -1 ? 0 : activeIdx;
  const nextIdx = (currentIdx + 1) % list.length;
  const next = list[nextIdx];
  const nextLabel = LABELS[next.oddsType];

  // Border color hints at the NEXT variant the user will land on — green ring
  // means "tap me to swap to goblin", orange for demon, yellow for standard.
  const ringColor = NEXT_COLOR[next.oddsType];

  return (
    <motion.button
      onClick={(e) => {
        e.stopPropagation();
        onChange(next.prop);
      }}
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.92, rotate: 180 }}
      transition={{ type: "spring", damping: 14, stiffness: 320 }}
      aria-label={`Swap line. Currently ${LABELS[activeOddsType]} at ${
        list[currentIdx]?.prop.line
      }. Tap to switch to ${nextLabel} at ${next.prop.line}.`}
      title={`Tap to swap → ${nextLabel} line ${next.prop.line}`}
      className={cn(
        "relative inline-flex items-center justify-center rounded-full border-2 transition-colors",
        "text-white/80 hover:text-white bg-[#0D0D1A]/40 hover:bg-[#0D0D1A]/70",
        "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#0D0D1A]",
        compact ? "w-6 h-6" : "w-7 h-7",
      )}
      style={{
        borderColor: ringColor,
        // @ts-expect-error CSS custom property for focus ring color
        "--tw-ring-color": ringColor,
      }}
    >
      <ArrowLeftRight size={compact ? 11 : 13} strokeWidth={3} aria-hidden />
    </motion.button>
  );
}
