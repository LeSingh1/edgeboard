"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PickSide, Prop } from "@/lib/types";

export interface SelectedPick {
  propId: string;
  side: PickSide;
  prop: Prop; // snapshot at selection time
  addedAt: number;
}

interface SelectionState {
  picks: SelectedPick[];
  benchOpen: boolean;
  add: (prop: Prop, side: PickSide) => void;
  remove: (propId: string) => void;
  toggle: (prop: Prop, side: PickSide) => void;
  sideFor: (propId: string) => PickSide | null;
  clear: () => void;
  setBenchOpen: (open: boolean) => void;
}

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      picks: [],
      benchOpen: false,
      add: (prop, side) =>
        set((s) => {
          const without = s.picks.filter((p) => p.propId !== prop.id);
          return {
            picks: [
              ...without,
              { propId: prop.id, side, prop, addedAt: Date.now() },
            ],
          };
        }),
      remove: (propId) =>
        set((s) => ({ picks: s.picks.filter((p) => p.propId !== propId) })),
      toggle: (prop, side) => {
        const existing = get().picks.find((p) => p.propId === prop.id);
        if (existing && existing.side === side) {
          get().remove(prop.id);
        } else {
          get().add(prop, side);
        }
      },
      sideFor: (propId) => {
        const p = get().picks.find((x) => x.propId === propId);
        return p ? p.side : null;
      },
      clear: () => set({ picks: [] }),
      setBenchOpen: (open) => set({ benchOpen: open }),
    }),
    {
      name: "edgeboard-selection",
      version: 2, // bumped: schema changed (now stores Prop snapshot)
      migrate: (persisted, version) => {
        // Old format had no `prop` field — start fresh on upgrade
        if (version < 2) return { picks: [], benchOpen: false };
        return persisted as SelectionState;
      },
    },
  ),
);
