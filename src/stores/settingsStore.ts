"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  anthropicKey: string;
  ballDontLieKey: string;   // Free key from balldontlie.io — unlocks NBA / WNBA real projections
  pollingMinutes: number;
  enabledSports: string[] | null;
  /** When true, Auto-Pilot drops any prop whose team isn't in the
   *  pre-warmed NBA playoff team set. Hard filter — the user has to
   *  un-tick this to see non-playoff picks. */
  playoffsOnly: boolean;
  setAnthropicKey: (k: string) => void;
  setBallDontLieKey: (k: string) => void;
  setPolling: (m: number) => void;
  toggleSport: (name: string, on: boolean) => void;
  setPlayoffsOnly: (on: boolean) => void;
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
      setAnthropicKey: (k) => set({ anthropicKey: k }),
      setBallDontLieKey: (k) => set({ ballDontLieKey: k }),
      setPolling: (m) => set({ pollingMinutes: Math.max(2, Math.min(30, m)) }),
      toggleSport: (name, on) => {
        const cur = get().enabledSports ?? [];
        if (on && !cur.includes(name)) set({ enabledSports: [...cur, name] });
        else if (!on) set({ enabledSports: cur.filter((s) => s !== name) });
      },
      setPlayoffsOnly: (on) => set({ playoffsOnly: on }),
      reset: () =>
        set({ anthropicKey: "", ballDontLieKey: "", pollingMinutes: 5, enabledSports: null, playoffsOnly: false }),
    }),
    { name: "edgeboard-settings" },
  ),
);
