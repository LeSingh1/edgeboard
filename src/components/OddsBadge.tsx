"use client";

import type { OddsType } from "@/lib/types";

interface OddsBadgeProps {
  oddsType: OddsType;
  compact?: boolean;
  /**
   * Icon-only mode — just the PrizePicks goblin/demon glyph, no label,
   * no multiplier. Matches the PrizePicks card header treatment.
   */
  iconOnly?: boolean;
}

// Authentic PrizePicks goblin + demon assets (96×96 PNG, transparent bg).
// Pulled from PrizePicks' own web bundle and bundled locally so the URL
// doesn't break the next time they hash-bust their static assets.
const GOBLIN_SRC = "/goblin.png";
const DEMON_SRC = "/demon.png";

/**
 * Visual indicator for PrizePicks' odds_type modifier.
 *
 *   demon  → PrizePicks demon glyph, red/orange, "×1.5" payout label
 *   goblin → PrizePicks goblin glyph, green,    "×0.85" payout label
 *   standard → no badge (default state)
 *
 * When `iconOnly` is set, renders just the glyph (matches PrizePicks header).
 */
export function OddsBadge({ oddsType, compact = false, iconOnly = false }: OddsBadgeProps) {
  if (oddsType === "standard") return null;

  const isDemon = oddsType === "demon";
  const color = isDemon ? "#FF6B35" : "#4ADE80";
  const src = isDemon ? DEMON_SRC : GOBLIN_SRC;
  const title = isDemon
    ? "Demon — harder line, boosted payout (actual multiplier depends on slip size)"
    : "Goblin — easier line, reduced payout (actual multiplier depends on slip size)";

  // Icon-only: PrizePicks' actual goblin/demon PNG, no border/text.
  // Sized to match PrizePicks' card treatment where the glyph is the visual
  // focal point of the variant indicator — small chip in compact spots,
  // chunky badge on the live-board card header.
  if (iconOnly) {
    const size = compact ? 20 : 32;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={isDemon ? "Demon" : "Goblin"}
        title={title}
        width={size}
        height={size}
        className="inline-block shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }

  // Full chip with PrizePicks glyph + label + multiplier (bench rows, slips, etc.)
  return (
    <span
      title={title}
      className={
        "inline-flex items-center gap-1 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-widest " +
        (compact ? "px-1.5 py-0 text-[8px]" : "px-2 py-0.5 text-[9px]")
      }
      style={{
        borderColor: color,
        color,
        backgroundColor: `${color}26`, // ~15% alpha
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        aria-hidden
        width={compact ? 12 : 14}
        height={compact ? 12 : 14}
        style={{ width: compact ? 12 : 14, height: compact ? 12 : 14 }}
      />
      {isDemon ? "Demon" : "Goblin"}
    </span>
  );
}
