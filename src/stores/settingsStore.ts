"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { OddsPreference } from "@/lib/autoPilot";

interface SettingsState {
  anthropicKey: string;
  ballDontLieKey: string;   // Free key from balldontlie.io — unlocks NBA / WNBA real projections
  pollingMinutes: number;
  enabledSports: string[] | null;
  /** When true, Auto-Pilot drops any prop whose team isn't in the
   *  pre-warmed NBA playoff team set. Hard filter — the user has to
   *  un-tick this to see non-playoff picks. */
  playoffsOnly: boolean;
  /** Mirrors whether the server is applying the trained isotonic
   *  calibration corrector. As of the per-oddsType rollout, calibration
   *  applies server-side whenever `data/backtest/calibration.json` is
   *  present — this flag is informational (drives the UI "calibrated"
   *  badge). To actually disable calibration, set `DISABLE_CALIBRATION=1`
   *  in the server env. */
  calibrationEnabled: boolean;
  /** Which PrizePicks pick style the user leans toward — green goblins (safer,
   *  smaller payout), red demons (riskier, bigger payout), standard lines only,
   *  or "balanced" (default; let the algorithm choose by quality). Feeds the
   *  Auto-Pilot builder and the budget chat so picks reflect the preference. */
  oddsPreference: OddsPreference;
  /** When true (default), the Auto-Pilot + chat weight CONSISTENT players above
   *  volatile ones, even at equal hit probability — safer slips. Consistency is
   *  the recent line-clear rate (how often the player actually beat the line in
   *  recent games). The user opted into this as the standing default ("favor
   *  consistent players for safer bets"). */
  favorConsistency: boolean;
  setAnthropicKey: (k: string) => void;
  setBallDontLieKey: (k: string) => void;
  setPolling: (m: number) => void;
  toggleSport: (name: string, on: boolean) => void;
  setPlayoffsOnly: (on: boolean) => void;
  setCalibrationEnabled: (on: boolean) => void;
  setOddsPreference: (p: OddsPreference) => void;
  setFavorConsistency: (on: boolean) => void;
  reset: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      anthropicKey: "",
      ballDontLieKey: "",
      pollingMinutes: 5,
      enabledSports: null,
      playoffsOnly: false,
      calibrationEnabled: true,
      oddsPreference: "balanced",
      favorConsistency: true,
      setAnthropicKey: (k) => set({ anthropicKey: k }),
      setBallDontLieKey: (k) => set({ ballDontLieKey: k }),
      setPolling: (m) => set({ pollingMinutes: Math.max(2, Math.min(30, m)) }),
      toggleSport: (name, on) => {
        const cur = get().enabledSports ?? [];
        if (on && !cur.includes(name)) set({ enabledSports: [...cur, name] });
        else if (!on) set({ enabledSports: cur.filter((s) => s !== name) });
      },
      setPlayoffsOnly: (on) => set({ playoffsOnly: on }),
      setCalibrationEnabled: (on) => set({ calibrationEnabled: on }),
      setOddsPreference: (p) => set({ oddsPreference: p }),
      setFavorConsistency: (on) => set({ favorConsistency: on }),
      reset: () =>
        set({
          anthropicKey: "",
          ballDontLieKey: "",
          pollingMinutes: 5,
          enabledSports: null,
          playoffsOnly: false,
          calibrationEnabled: true,
          oddsPreference: "balanced",
          favorConsistency: true,
        }),
    }),
    { name: "edgeboard-settings" },
  ),
);
