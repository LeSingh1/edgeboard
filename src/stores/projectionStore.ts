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
  fetchOne: (prop: Prop, ballDontLieKey?: string, intel?: { swing?: number; evidence?: string }) => Promise<void>;
  clear: () => void;
}

// ──────────────────────────────────────────────────────────────────────
// Concurrency queue — at most MAX_INFLIGHT real-projection fetches can
// be in flight at once. The live-board can mount 30+ PropBox cards on
// page load; without a queue we'd fire 30 parallel ESPN searches and
// risk rate limits / slowdowns. With max 3 in-flight, the queue drains
// in ~3–6 seconds for a typical board. Each prop gets resolved exactly
// once per session (persisted via zustand/persist).
// ──────────────────────────────────────────────────────────────────────

const MAX_INFLIGHT = 3;
const queue: Array<() => Promise<void>> = [];
let inflight = 0;

function drain() {
  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    const job = queue.shift()!;
    inflight++;
    job().finally(() => {
      inflight--;
      drain();
    });
  }
}

function enqueue(job: () => Promise<void>) {
  queue.push(job);
  drain();
}

export const useProjectionStore = create<ProjectionState>()(
  persist(
    (set, get) => ({
      byProp: {},
      pending: new Set(),
      fetchOne: async (prop, ballDontLieKey, intel) => {
        const state = get();
        // Already cached this session — bail.
        // Skip the cache for stale `available: false` entries: when projection
        // logic ships a new path (e.g. NBA1Q segment scaling), props that
        // previously returned "no model" now return real data, and we want
        // those to refetch on next mount instead of being stuck on PP DEFAULT.
        const cached = state.byProp[prop.id];
        if (cached && cached.available) return;
        if (state.pending.has(prop.id)) return;
        state.pending.add(prop.id);

        return new Promise<void>((resolve) => {
          enqueue(async () => {
            try {
              // Bake intel into the prop so the server applies it inside
              // the projection pipeline (consistent across all consumers).
              const enrichedProp = intel
                ? { ...prop, intelSwing: intel.swing, intelEvidence: intel.evidence }
                : prop;
              const res = await fetch("/api/projection", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prop: enrichedProp, ballDontLieKey }),
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
              resolve();
            }
          });
        });
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
 *
 * Calibration is applied server-side in `realProjections.ts` for NBA/WNBA
 * props, so the pMore stored here is already corrected when applicable.
 * The `+iso` suffix on `modelVersion` indicates that calibration ran.
 * Callers should NOT re-apply a corrector — doing so would double-correct.
 */
export function effectiveProb(
  prop: Prop,
  side: "more" | "less",
  byProp: Record<string, ProjectionResult>,
): { p: number; source: "real" | "implied"; modelVersion: string; sampleSize?: number; calibrated?: boolean } {
  const real = byProp[prop.id];
  if (real && real.available) {
    return {
      p: side === "more" ? real.pMore : real.pLess,
      source: "real",
      modelVersion: real.modelVersion,
      sampleSize: real.sampleSize,
      calibrated: real.modelVersion.includes("+iso"),
    };
  }
  return {
    p: side === "more" ? prop.pMore : prop.pLess,
    source: "implied",
    modelVersion: prop.modelVersion ?? "implied-v1",
  };
}
