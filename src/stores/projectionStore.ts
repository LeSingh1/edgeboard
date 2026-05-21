"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Prop } from "@/lib/types";
import type { ProjectionResult } from "@/lib/realProjections";

interface ProjectionState {
  /** propId → latest real projection result (or "unavailable" with reason) */
  byProp: Record<string, ProjectionResult>;
  /** propIds currently being fetched */
  pending: Set<string>;
  fetchOne: (prop: Prop, ballDontLieKey?: string) => Promise<void>;
  clear: () => void;
}

export const useProjectionStore = create<ProjectionState>()(
  persist(
    (set, get) => ({
      byProp: {},
      pending: new Set(),
      fetchOne: async (prop, ballDontLieKey) => {
        const state = get();
        if (state.byProp[prop.id] && "available" in state.byProp[prop.id]) {
          return; // already cached this session
        }
        if (state.pending.has(prop.id)) return;
        state.pending.add(prop.id);
        try {
          const res = await fetch("/api/projection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prop, ballDontLieKey }),
          });
          const data = (await res.json()) as ProjectionResult;
          set((s) => ({ byProp: { ...s.byProp, [prop.id]: data } }));
        } catch (e) {
          set((s) => ({
            byProp: {
              ...s.byProp,
              [prop.id]: {
                available: false,
                reason: e instanceof Error ? e.message : String(e),
              },
            },
          }));
        } finally {
          state.pending.delete(prop.id);
        }
      },
      clear: () => set({ byProp: {}, pending: new Set() }),
    }),
    {
      name: "edgeboard-projections",
      partialize: (state) => ({ byProp: state.byProp }), // don't persist `pending`
    },
  ),
);

/**
 * Helper: given a prop and the projection store, return the best probability
 * we have — real if available, else PrizePicks-implied as fallback.
 */
export function effectiveProb(
  prop: Prop,
  side: "more" | "less",
  byProp: Record<string, ProjectionResult>,
): { p: number; source: "real" | "implied"; modelVersion: string; sampleSize?: number } {
  const real = byProp[prop.id];
  if (real && real.available) {
    return {
      p: side === "more" ? real.pMore : real.pLess,
      source: "real",
      modelVersion: real.modelVersion,
      sampleSize: real.sampleSize,
    };
  }
  return {
    p: side === "more" ? prop.pMore : prop.pLess,
    source: "implied",
    modelVersion: prop.modelVersion ?? "implied-v1",
  };
}
