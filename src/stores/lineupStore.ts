"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Lineup, PlayType, RiskMode } from "@/lib/types";

export type SlipStatus = "draft" | "entered" | "won" | "lost" | "partial";

interface LineupState {
  lineups: Lineup[];
  totalGenerated: number;
  elapsedMs: number;
  params: {
    lineupSize: number;
    playType: PlayType;
    entryCost: number;
    riskMode: RiskMode;
    /**
     * Optional hard cap on total dollars across all played lineups. When set,
     * the slips page divides this by the recommended-portfolio size to show
     * a per-lineup stake suggestion: "your $100 → $20 × 5 lineups."
     * 0 / undefined means "no cap, use entryCost × N."
     */
    maxBudget?: number;
  } | null;
  /** Tracked status per lineup id; survives navigation + reload. */
  statuses: Record<string, SlipStatus>;
  setResults: (data: {
    lineups: Lineup[];
    totalGenerated: number;
    elapsedMs: number;
    params: LineupState["params"];
  }) => void;
  setStatus: (lineupId: string, status: SlipStatus) => void;
  clear: () => void;
}

export const useLineupStore = create<LineupState>()(
  persist(
    (set) => ({
      lineups: [],
      totalGenerated: 0,
      elapsedMs: 0,
      params: null,
      statuses: {},
      setResults: (data) =>
        set({
          lineups: data.lineups,
          totalGenerated: data.totalGenerated,
          elapsedMs: data.elapsedMs,
          params: data.params,
        }),
      setStatus: (lineupId, status) =>
        set((s) => ({ statuses: { ...s.statuses, [lineupId]: status } })),
      clear: () =>
        set({ lineups: [], totalGenerated: 0, elapsedMs: 0, params: null }),
    }),
    {
      name: "edgeboard-lineups",
      partialize: (state) => ({ statuses: state.statuses }), // only persist statuses
    },
  ),
);
