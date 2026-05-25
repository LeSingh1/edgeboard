"use client";

import { create } from "zustand";
import { applyCalibrationModel, type CalibrationModel } from "@/lib/backtest/fitCalibration";

/**
 * Client-side store for the trained isotonic calibration model.
 *
 * Mirrors the on-disk `data/backtest/calibration.json`. Loaded lazily on
 * first read of /api/backtest/report. Lives in memory only; refreshed
 * on every page load (~1ms file read on the server).
 *
 * Consumed by `effectiveProb()` in projectionStore — when both
 * `calibrationEnabled` (settingsStore) is true AND we have a model
 * loaded here, real-projection pMore values are routed through it
 * before being returned.
 */

interface CalibrationState {
  model: CalibrationModel | null;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  /** Apply the model to a raw pMore. Returns input unchanged if no
   *  model is loaded. */
  apply: (predicted: number) => number;
}

export const useCalibrationStore = create<CalibrationState>((set, get) => ({
  model: null,
  loaded: false,
  loading: false,
  load: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const res = await fetch("/api/backtest/report");
      if (!res.ok) {
        set({ loaded: true, loading: false });
        return;
      }
      const body = (await res.json()) as {
        available?: boolean;
        calibration?: CalibrationModel | null;
      };
      set({
        model: body.available ? body.calibration ?? null : null,
        loaded: true,
        loading: false,
      });
    } catch {
      set({ loaded: true, loading: false });
    }
  },
  apply: (predicted: number) => {
    const m = get().model;
    if (!m) return predicted;
    return applyCalibrationModel(m, predicted);
  },
}));
