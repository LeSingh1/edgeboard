"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SlipStatus } from "@/stores/lineupStore";

export interface SlipRecord {
  id: string;
  enteredAt: number;
  entry: number;
  payout: number;       // gross potential
  hitProb: number;
  status: SlipStatus;
  result?: "won" | "lost" | "partial";
  realizedReturn?: number;
}

interface BankrollState {
  records: SlipRecord[];
  recordEntry: (rec: Omit<SlipRecord, "enteredAt" | "status">) => void;
  resolve: (id: string, status: "won" | "lost" | "partial", realizedReturn: number) => void;
  remove: (id: string) => void;
  reset: () => void;
}

export const useBankrollStore = create<BankrollState>()(
  persist(
    (set) => ({
      records: [],
      recordEntry: (rec) =>
        set((s) => ({
          records: [
            ...s.records.filter((r) => r.id !== rec.id),
            { ...rec, enteredAt: Date.now(), status: "entered" },
          ],
        })),
      resolve: (id, status, realizedReturn) =>
        set((s) => ({
          records: s.records.map((r) =>
            r.id === id ? { ...r, status, result: status, realizedReturn } : r,
          ),
        })),
      remove: (id) => set((s) => ({ records: s.records.filter((r) => r.id !== id) })),
      reset: () => set({ records: [] }),
    }),
    { name: "edgeboard-bankroll" },
  ),
);

/** Aggregate stats for /settings bankroll panel. */
export function bankrollSummary(records: SlipRecord[]) {
  const entered = records.filter((r) => r.status !== "draft");
  const resolved = records.filter((r) => r.realizedReturn !== undefined);
  const totalStaked = entered.reduce((a, r) => a + r.entry, 0);
  const totalReturn = resolved.reduce((a, r) => a + (r.realizedReturn ?? 0), 0);
  const profit = totalReturn - resolved.reduce((a, r) => a + r.entry, 0);
  const roi = totalStaked > 0 ? profit / totalStaked : 0;
  return {
    enteredCount: entered.length,
    resolvedCount: resolved.length,
    totalStaked,
    profit,
    roi,
  };
}
