"use client";

import { Activity, Hourglass, Database } from "lucide-react";
import { useProjectionStore } from "@/stores/projectionStore";

interface ProjectionBadgeProps {
  propId: string;
  compact?: boolean;
}

/**
 * Tiny indicator showing the data source for a pick's probability:
 *   - real    → "Real · MLB · 49 games" (green dot)
 *   - pending → "Fetching..." (yellow pulsing)
 *   - implied → "PrizePicks" (gray, default)
 *   - error   → "Falling back" (orange)
 */
export function ProjectionBadge({ propId }: ProjectionBadgeProps) {
  const result = useProjectionStore((s) => s.byProp[propId]);
  if (!result) {
    return (
      <span
        title="Fetching real projection..."
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded-full border-2 border-dashed border-white/30 text-white/40 font-[family-name:var(--font-heading)] font-black uppercase text-[8px] tracking-widest"
      >
        <Hourglass size={8} strokeWidth={3} className="animate-pulse" />
        loading
      </span>
    );
  }
  if (result.available) {
    return (
      <span
        title={`${result.source} · pMore=${(result.pMore * 100).toFixed(1)}% pLess=${(result.pLess * 100).toFixed(1)}% · projection ${result.projection} ± ${result.sigma}`}
        className="inline-flex items-center gap-1 px-1.5 py-0 rounded-full border-2 bg-[#4ADE80]/15 border-[#4ADE80] text-[#4ADE80] font-[family-name:var(--font-heading)] font-black uppercase text-[8px] tracking-widest"
      >
        <Activity size={8} strokeWidth={3} />
        real · {result.sampleSize}g
      </span>
    );
  }
  return (
    <span
      title={`Implied probability (no real model available): ${result.reason}`}
      className="inline-flex items-center gap-1 px-1.5 py-0 rounded-full border-2 bg-white/5 border-white/30 text-white/50 font-[family-name:var(--font-heading)] font-black uppercase text-[8px] tracking-widest"
    >
      <Database size={8} strokeWidth={3} />
      implied
    </span>
  );
}
