"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { familyKeyOf, type VariantSet } from "@/lib/variantGroups";
import type { PickSide, Prop } from "@/lib/types";

export interface SelectedPick {
  propId: string;
  side: PickSide;
  prop: Prop;               // snapshot at selection time — this is the user's active variant
  variants?: VariantSet;    // sibling demon/std/goblin props for the same family. The
                            //   optimizer is allowed to swap variants when generating lineups.
  addedAt: number;
}

interface SelectionState {
  picks: SelectedPick[];
  benchOpen: boolean;
  add: (prop: Prop, side: PickSide, variants?: VariantSet) => void;
  remove: (propId: string) => void;
  /** Switch the active variant of a family — used when the user clicks the swap arrow. */
  swapVariant: (oldPropId: string, newProp: Prop, variants?: VariantSet) => void;
  toggle: (prop: Prop, side: PickSide, variants?: VariantSet) => void;
  sideFor: (propId: string) => PickSide | null;
  /** Looks up whether ANY variant of the family is selected — used by PropBox to show selection. */
  sideForFamily: (prop: Prop) => { side: PickSide; activePropId: string } | null;
  clear: () => void;
  setBenchOpen: (open: boolean) => void;
}

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      picks: [],
      benchOpen: false,
      add: (prop, side, variants) =>
        set((s) => {
          // PrizePicks rule: demon and goblin lines are MORE-only. If a caller
          // somehow asks for LESS on one, coerce to MORE — otherwise the pick
          // would be unenterable on PrizePicks.
          const enforcedSide: PickSide =
            prop.oddsType !== "standard" ? "more" : side;
          // Remove any existing pick from the same family (only one variant per family
          // can be on the bench at a time — swapping replaces, doesn't duplicate)
          const targetFamily = familyKeyOf(prop);
          const without = s.picks.filter(
            (p) => p.propId !== prop.id && familyKeyOf(p.prop) !== targetFamily,
          );
          return {
            picks: [
              ...without,
              { propId: prop.id, side: enforcedSide, prop, variants, addedAt: Date.now() },
            ],
          };
        }),
      remove: (propId) =>
        set((s) => ({ picks: s.picks.filter((p) => p.propId !== propId) })),
      swapVariant: (oldPropId, newProp, variants) =>
        set((s) => {
          const existing = s.picks.find((p) => p.propId === oldPropId);
          if (!existing) return s;
          // Transfer the side onto the new variant; coerce to MORE if the new
          // variant is demon/goblin (which only accept MORE on PrizePicks).
          const enforcedSide: PickSide =
            newProp.oddsType !== "standard" ? "more" : existing.side;
          return {
            picks: s.picks.map((p) =>
              p.propId === oldPropId
                ? {
                    ...p,
                    propId: newProp.id,
                    prop: newProp,
                    side: enforcedSide,
                    variants: variants ?? p.variants,
                  }
                : p,
            ),
          };
        }),
      toggle: (prop, side, variants) => {
        const existing = get().picks.find((p) => p.propId === prop.id);
        if (existing && existing.side === side) {
          get().remove(prop.id);
        } else {
          get().add(prop, side, variants);
        }
      },
      sideFor: (propId) => {
        const p = get().picks.find((x) => x.propId === propId);
        return p ? p.side : null;
      },
      sideForFamily: (prop) => {
        const key = familyKeyOf(prop);
        const p = get().picks.find((x) => familyKeyOf(x.prop) === key);
        return p ? { side: p.side, activePropId: p.propId } : null;
      },
      clear: () => set({ picks: [] }),
      setBenchOpen: (open) => set({ benchOpen: open }),
    }),
    {
      name: "edgeboard-selection",
      version: 5, // back to singular {goblin?, standard?, demon?} — match PrizePicks app's display
      migrate: (persisted, version) => {
        // v4 stored ladders; v5 stores singular. Reset rather than migrate —
        // the bench is ephemeral anyway.
        if (version < 5) return { picks: [], benchOpen: false };
        return persisted as SelectionState;
      },
    },
  ),
);
