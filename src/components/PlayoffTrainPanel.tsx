"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import { Trophy, Zap, Check, AlertTriangle, Loader2 } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { cn } from "@/lib/cn";

interface WarmupSummary {
  teams: string[];
  playerCount: number;
  warmedAt: string | null;
  inProgress: boolean;
  progress: { done: number; total: number };
}

interface ProgressEvent {
  phase: "discover" | "discovered" | "player" | "error" | "done" | "fatal";
  message?: string;
  teams?: string[];
  totalPlayers?: number;
  player?: string;
  team?: string;
  done?: number;
  total?: number;
  newsCount?: number;
  signalCount?: number;
  playerCount?: number;
  warmedAt?: string;
  error?: string;
}

/**
 * Pre-warm playoff player data into the server cache.
 *
 * "Training" in the ML sense isn't possible until we have ~200 resolved
 * slips with outcome labels. What this does instead is the next best
 * thing: pull every player on every NBA team still alive in the playoffs,
 * fetch their full ESPN news feed (press conference quotes, injury
 * notes, beat-writer commentary), and run the heuristic intel parser
 * over each. Result: when one of these players shows up on the live
 * board, intel renders instantly with a deeper signal set than the
 * on-demand 5-article cap allows.
 *
 * Pairs with the "Playoff teams only" toggle so the optimizer's pool is
 * scoped to teams that are actually playing.
 */
export function PlayoffTrainPanel() {
  const playoffsOnly = useSettingsStore((s) => s.playoffsOnly);
  const setPlayoffsOnly = useSettingsStore((s) => s.setPlayoffsOnly);

  const [summary, setSummary] = useState<WarmupSummary | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [lastPlayer, setLastPlayer] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Poll the current cache state on mount + after every warmup completes.
  // Inlined inside the effect (and the post-warmup completion handler)
  // because pulling it out into a named function makes the
  // react-hooks/set-state-in-effect lint rule fire — the rule can't see
  // that the setState is gated behind an async fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/playoff-warmup");
        if (!r.ok || cancelled) return;
        const s = (await r.json()) as WarmupSummary;
        if (!cancelled) setSummary(s);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSummary = async () => {
    try {
      const r = await fetch("/api/playoff-warmup");
      if (!r.ok) return;
      const s = (await r.json()) as WarmupSummary;
      setSummary(s);
    } catch {
      /* ignore */
    }
  };

  const start = async () => {
    if (running) return;
    setRunning(true);
    setEvents([]);
    setError(null);
    setLastPlayer("");
    try {
      const res = await fetch("/api/playoff-warmup", { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Warmup failed (${res.status})`);
        setRunning(false);
        return;
      }
      // Streaming reader — server emits one JSON object per line.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try {
            const ev = JSON.parse(ln) as ProgressEvent;
            setEvents((prev) => [...prev.slice(-50), ev]);
            if (ev.phase === "player" && ev.player) {
              setLastPlayer(`${ev.player} (${ev.team})`);
            }
            if (ev.phase === "fatal" && ev.error) {
              setError(ev.error);
            }
          } catch {
            /* skip malformed line */
          }
        }
      }
      await refreshSummary();
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  const latestProgress = events.reduceRight<ProgressEvent | null>(
    (acc, ev) => acc || (ev.phase === "player" ? ev : null),
    null,
  );
  const total = latestProgress?.total ?? summary?.progress.total ?? 0;
  const done = latestProgress?.done ?? summary?.progress.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const warmedLabel = summary?.warmedAt
    ? new Date(summary.warmedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <section className="rounded-3xl border-4 border-[#FFE600] bg-gradient-to-br from-[#FFE600]/10 via-[#FF3AF2]/10 to-[#7B2FFF]/10 p-6 md:p-8">
      <div className="flex items-start gap-3 flex-wrap mb-4">
        <div className="w-12 h-12 rounded-2xl bg-[#FFE600] flex items-center justify-center flex-shrink-0">
          <Trophy size={26} strokeWidth={3} className="text-[#0D0D1A]" aria-hidden />
        </div>
        <div className="flex-1 min-w-[220px]">
          <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-2xl md:text-3xl text-white leading-none">
            Train on NBA playoffs
          </h2>
          <p className="text-white/65 text-sm mt-2 max-w-xl">
            Pulls every player on every alive playoff team, fetches their full ESPN
            news feed (press conference quotes, injury notes, beat-writer commentary),
            and pre-extracts heuristic intel signals. When these players appear on the
            board, intel renders instantly with way more depth than on-demand.
          </p>
          <p className="text-white/40 text-xs mt-2 max-w-xl leading-relaxed">
            Heads up: this isn&apos;t ML training — it&apos;s data enrichment. Real model
            training needs ~200 resolved slips with outcome labels first. This makes
            the existing heuristic much smarter in the meantime.
          </p>
        </div>
      </div>

      {/* Status summary */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5 mb-5">
          <SummaryTile
            label="Alive teams"
            value={summary.teams.length === 0 ? "—" : summary.teams.join(" · ")}
            accent="#00F5D4"
          />
          <SummaryTile
            label="Players cached"
            value={summary.playerCount === 0 ? "0" : summary.playerCount.toString()}
            accent="#FFE600"
          />
          <SummaryTile
            label="Last warmed"
            value={warmedLabel ?? "Never"}
            accent={warmedLabel ? "#4ADE80" : "#F87171"}
          />
        </div>
      )}

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={start}
          disabled={running}
          className={cn(
            "inline-flex items-center gap-2 px-5 py-3 rounded-full border-4 border-[#FFE600]",
            "bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4]",
            "font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-sm",
            "hover:scale-[1.02] active:scale-[0.98] transition-transform",
            "focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FFE600]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D0D1A]",
            "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
          )}
        >
          {running ? (
            <>
              <Loader2 size={16} strokeWidth={3} className="animate-spin" aria-hidden />
              {pct}% · {lastPlayer || "Starting…"}
            </>
          ) : (
            <>
              <Zap size={16} strokeWidth={3} aria-hidden />
              {summary?.warmedAt ? "Re-train" : "Train on playoffs"}
            </>
          )}
        </button>

        {/* Playoffs-only toggle — separate from the warmup so the user can
            scope the optimizer even without a fresh warmup, but the toggle
            is most useful AFTER warming up. */}
        <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full border-2 border-white/15 cursor-pointer hover:border-white/30 transition-colors">
          <input
            type="checkbox"
            checked={playoffsOnly}
            onChange={(e) => setPlayoffsOnly(e.target.checked)}
            className="w-4 h-4 accent-[#FFE600]"
          />
          <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[11px] text-white/80">
            Playoff teams only
          </span>
        </label>
      </div>

      {/* Live progress bar */}
      {running && total > 0 && (
        <div className="mt-5">
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4]"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ type: "spring", damping: 30 }}
            />
          </div>
          <div className="mt-2 flex justify-between text-[10px] uppercase tracking-widest font-bold text-white/45">
            <span>{done} / {total} players</span>
            <span>{pct}%</span>
          </div>
        </div>
      )}

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4 flex items-start gap-2 rounded-xl border-2 border-[#F87171] bg-[#F87171]/10 text-[#F87171] p-3 text-sm font-bold"
            role="alert"
          >
            <AlertTriangle size={16} strokeWidth={3} className="flex-shrink-0 mt-0.5" aria-hidden />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recent events feed */}
      {events.length > 0 && (
        <div className="mt-5 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-[#0D0D1A]/60 p-3 text-xs font-mono">
          {events.slice(-20).map((ev, i) => (
            <EventLine key={i} ev={ev} />
          ))}
        </div>
      )}
    </section>
  );
}

function SummaryTile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      className="rounded-xl border-2 px-3 py-2.5 bg-[#0D0D1A]/60"
      style={{ borderColor: `${accent}60` }}
    >
      <div
        className="text-[9px] uppercase tracking-widest font-bold mb-1"
        style={{ color: accent }}
      >
        {label}
      </div>
      <div className="font-[family-name:var(--font-heading)] font-black text-white text-sm md:text-base truncate">
        {value}
      </div>
    </div>
  );
}

function EventLine({ ev }: { ev: ProgressEvent }) {
  if (ev.phase === "player") {
    return (
      <div className="flex items-center gap-2 text-white/65 py-0.5">
        <Check size={11} strokeWidth={3} className="text-[#4ADE80] flex-shrink-0" aria-hidden />
        <span className="text-white/85">{ev.player}</span>
        <span className="text-white/40">({ev.team})</span>
        <span className="text-white/40 ml-auto">
          {ev.newsCount}n · {ev.signalCount}s
        </span>
      </div>
    );
  }
  if (ev.phase === "discovered") {
    return (
      <div className="text-[#00F5D4] py-1">
        Found {ev.totalPlayers} players across {ev.teams?.join(", ")}
      </div>
    );
  }
  if (ev.phase === "done") {
    return (
      <div className="text-[#4ADE80] font-bold py-1">
        ✓ Warmed {ev.playerCount} players · ready
      </div>
    );
  }
  if (ev.phase === "error" || ev.phase === "fatal") {
    return (
      <div className="text-[#F87171] py-0.5">
        ✗ {ev.player ?? "fatal"}: {ev.error}
      </div>
    );
  }
  if (ev.phase === "discover") {
    return <div className="text-white/55 py-0.5">{ev.message}</div>;
  }
  return null;
}
