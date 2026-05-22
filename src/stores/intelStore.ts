"use client";

import { create } from "zustand";
import type { Prop } from "@/lib/types";
import type { IntelResponse } from "@/app/api/intel/route";

interface IntelState {
  /** propId → latest intel result (or unavailable). In-memory only; refreshes per session. */
  byProp: Record<string, IntelResponse>;
  /** propIds currently fetching */
  pending: Set<string>;
  fetchOne: (prop: Prop, anthropicKey?: string) => Promise<void>;
  clear: () => void;
}

export const useIntelStore = create<IntelState>((set, get) => ({
  byProp: {},
  pending: new Set(),
  fetchOne: async (prop, anthropicKey) => {
    const state = get();
    // Already cached — skip
    if (state.byProp[prop.id]) return;
    if (state.pending.has(prop.id)) return;
    state.pending.add(prop.id);
    try {
      const res = await fetch("/api/intel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prop, anthropicKey }),
      });
      const data = (await res.json()) as IntelResponse;
      set((s) => ({ byProp: { ...s.byProp, [prop.id]: data } }));
    } catch (e) {
      set((s) => ({
        byProp: {
          ...s.byProp,
          [prop.id]: {
            available: false,
            signals: [],
            combinedSwing: 0,
            newsCount: 0,
            source: "heuristic",
            topHeadlines: [],
            reason: e instanceof Error ? e.message : String(e),
          },
        },
      }));
    } finally {
      state.pending.delete(prop.id);
    }
  },
  clear: () => set({ byProp: {}, pending: new Set() }),
}));
