"use client";

import { Activity, Hourglass } from "lucide-react";
import { useProjectionStore } from "@/stores/projectionStore";

interface ProjectionBadgeProps {
  propId: string;
  compact?: boolean;
}

/**
 * Tiny indicator showing projection model status for this pick:
 *   - real      → "Edge · 91g"  (green, computed from the player's recent games)
 *   - pending   → spinner       (fetching the game log right now)
 *   - none      → nothing       (no model available — card shows no %)
 *
 * When the model is available, the MORE/LESS buttons show percentages.
 * When it's not, they show clean labels without misleading numbers.
 */
export function ProjectionBadge({ propId }: ProjectionBadgeProps) {
  const result = useProjectionStore((s) => s.byProp[propId]);
  if (!result) {
    return (
      <span
        title="Analyzing this player's recent games..."
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded-full border-2 border-dashed border-white/30 text-white/40 font-[family-name:var(--font-heading)] font-black uppercase text-[8px] tracking-widest"
      >
        <Hourglass size={8} strokeWidth={3} className="animate-pulse" />
      </span>
    );
  }
  if (result.available) {
    return (
      <span
        title={`Projection: ${result.projection} avg (${result.sampleSize} games, ±${result.sigma})`}
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded-full border-2 bg-[#4ADE80]/15 border-[#4ADE80] text-[#4ADE80] font-[family-name:var(--font-heading)] font-black uppercase text-[8px] tracking-widest"
      >
        <Activity size={8} strokeWidth={3} />
        Edge · {result.sampleSize}g
      </span>
    );
  }
  return null;
}
