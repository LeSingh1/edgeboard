"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Zap,
  Trophy,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Layers,
  Sliders,
  Filter,
  Loader2,
  AlertTriangle,
  Wand2,
  Copy,
  Check,
} from "lucide-react";
import { buildAutoLineups, pickAutoSize, type AutoPilotResult } from "@/lib/autoPilot";
import { useProjectionStore } from "@/stores/projectionStore";
import { useLineupStore } from "@/stores/lineupStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { OddsBadge } from "@/components/OddsBadge";
import { AnimatedPercent } from "@/components/AnimatedPercent";
import { PlayerDetailModal } from "@/components/PlayerDetailModal";
import { accentHexFor, cn } from "@/lib/cn";
import type { LeagueSummary, PickSide, Prop } from "@/lib/types";

const ENTRY_PRESETS = [5, 10, 20, 50, 100] as const;
const LINEUP_SIZES = [2, 3, 4, 5, 6] as const;
const LINEUP_COUNTS = [1, 2, 3, 4, 5] as const;

/**
 * Defaults used whenever a control is left on "auto":
 *   count → 3   (gives variety without being overwhelming)
 *   size  → resolved at run-time by pickAutoSize() against the live board
 *   entry → $20 (PrizePicks median single-slip ticket)
 *   sport → ALL (no filter — auto = "we choose")
 */
const AUTO_COUNT_DEFAULT = 3;
const AUTO_ENTRY_DEFAULT = 20;
type AutoOr<T> = "auto" | T;

interface ApiResponse {
  props: Prop[];
  leagues: LeagueSummary[];
  total: number;
  fetchedAt: string;
}

export default function AutoPilotPage() {
  const router = useRouter();
  const setLineupResults = useLineupStore((s) => s.setResults);
  const byProp = useProjectionStore((s) => s.byProp);

  // Playoffs-only filter — pulled from settings + the live playoff cache.
  // When the user has flipped this on, we ask the warmup endpoint for the
  // current alive-team set and pass it as a hard allowlist to the
  // optimizer. Empty allowlist = no filter (graceful fallback when the
  // cache hasn't been warmed yet).
  const playoffsOnly = useSettingsStore((s) => s.playoffsOnly);
  const [playoffTeams, setPlayoffTeams] = useState<string[]>([]);
  useEffect(() => {
    if (!playoffsOnly) return;
    fetch("/api/playoff-warmup")
      .then((r) => r.json())
      .then((d: { teams?: string[] }) => setPlayoffTeams(d.teams ?? []))
      .catch(() => null);
  }, [playoffsOnly]);

  // Selection store — clicking MORE/LESS inside the PlayerDetailModal goes
  // through here so the bench stays in sync with whatever pick the user
  // committed to. Same wiring as PropBox uses on the Live Board.
  const benchPicks = useSelectionStore((s) => s.picks);
  const toggleSelection = useSelectionStore((s) => s.toggle);

  // Single page-level state for the player-detail modal. We open it from
  // any pick row in any lineup card — one modal instance, lifted up so
  // we don't pay React-tree-reconcile cost re-mounting it on every click.
  const [inspectedProp, setInspectedProp] = useState<Prop | null>(null);

  const [board, setBoard] = useState<ApiResponse | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [boardError, setBoardError] = useState<string | null>(null);

  // Controls — every knob can be left on "auto" so the user can hand the
  // whole decision (or any subset) to the algorithm.
  const [lineupCount, setLineupCount] = useState<AutoOr<number>>("auto");
  const [lineupSize, setLineupSize] = useState<AutoOr<number>>("auto");
  const [entry, setEntry] = useState<AutoOr<number>>("auto");
  const [sport, setSport] = useState<AutoOr<string>>("auto");
  const [crunching, setCrunching] = useState(false);
  const [result, setResult] = useState<AutoPilotResult | null>(null);
  // Ref to the results section so we can smooth-scroll it into view when
  // "Build my lineups" finishes. Without this, on tall screens the user
  // hits Build and nothing visibly happens — the lineups render hundreds
  // of pixels below the fold.
  const resultsRef = useRef<HTMLElement | null>(null);
  /** What the algorithm actually picked when controls were on auto.
   *  Stored alongside the result so the UI can say "we chose 4-pick at $20". */
  const [resolvedParams, setResolvedParams] = useState<{
    lineupCount: number;
    lineupSize: number;
    entry: number;
    sport: string;
  } | null>(null);

  const allAuto =
    lineupCount === "auto" &&
    lineupSize === "auto" &&
    entry === "auto" &&
    sport === "auto";

  const setAllAuto = () => {
    setLineupCount("auto");
    setLineupSize("auto");
    setEntry("auto");
    setSport("auto");
  };

  // Fetch the board on mount. Same endpoint the live-board uses — already
  // cached for 5 min upstream, so this is cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/props");
        if (!res.ok) throw new Error(`Upstream ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        if (cancelled) return;
        setBoard(json);
        setBoardError(null);
      } catch (e) {
        if (cancelled) return;
        setBoardError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingBoard(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // How many props are available in the current sport filter — drives the
  // pre-flight number so the user knows what pool we're searching. `auto`
  // and explicit `ALL` both mean "no filter", so they're equivalent here.
  const filteredCount = useMemo(() => {
    if (!board) return 0;
    if (sport === "auto" || sport === "ALL") return board.total;
    return board.props.filter((p) => p.sport === sport).length;
  }, [board, sport]);

  // Top leagues for the sport pills — capped at 8 to keep the row tidy.
  const leagueOptions = useMemo<LeagueSummary[]>(() => {
    if (!board) return [];
    return [{ name: "ALL", count: board.total }, ...board.leagues.slice(0, 8)];
  }, [board]);

  const handleGenerate = async () => {
    if (!board || crunching) return;
    setCrunching(true);
    // Yield a frame so the spinner can paint before the math kicks off.
    await new Promise((r) => setTimeout(r, 50));

    // Resolve every "auto" knob to a concrete value. Size is the only one
    // that costs anything to resolve — pickAutoSize sweeps 2..6 against the
    // live board to find the size with the best expected dollars.
    const resolvedSport = sport === "auto" ? "ALL" : sport;
    // If the user has "Playoff teams only" on and we have a cached team
    // list, build an allowlist Set the optimizer can hard-filter on.
    // Empty set means no filter (graceful fallback when cache isn't warm).
    const allowlist = playoffsOnly && playoffTeams.length > 0
      ? new Set(playoffTeams.map((t) => t.toUpperCase()))
      : undefined;
    const optionsForSizing = {
      sport: resolvedSport,
      realProjections: byProp,
      teamAllowlist: allowlist,
    };
    const resolved = {
      lineupCount: lineupCount === "auto" ? AUTO_COUNT_DEFAULT : lineupCount,
      lineupSize:
        lineupSize === "auto" ? pickAutoSize(board.props, optionsForSizing) : lineupSize,
      entry: entry === "auto" ? AUTO_ENTRY_DEFAULT : entry,
      sport: resolvedSport,
    };

    const r = buildAutoLineups(
      board.props,
      resolved.lineupSize,
      resolved.lineupCount,
      resolved.entry,
      { sport: resolved.sport, realProjections: byProp, teamAllowlist: allowlist },
    );
    setResult(r);
    setResolvedParams(resolved);
    setCrunching(false);

    // Smooth-scroll to the freshly-rendered results. Two requestAnimationFrame
    // waits: the first lets React commit the new state and paint the section
    // into the DOM; the second lets framer-motion's entrance animation start
    // so we follow the layout that it's settling into, not the pre-animation
    // one. scrollIntoView with behavior:"smooth" gets the browser's native
    // easing — cheap, accessible, respects prefers-reduced-motion.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  };

  // Push the generated lineups into the slip store and jump to the
  // leaderboard view — same shape the Optimizer page uses, so /slips
  // renders them without any special-casing.
  const handleSendToSlips = () => {
    if (!result || result.lineups.length === 0 || !resolvedParams) return;
    setLineupResults({
      lineups: result.lineups,
      totalGenerated: result.totalEvaluated,
      elapsedMs: result.elapsedMs,
      params: {
        lineupSize: resolvedParams.lineupSize,
        playType: result.lineups[0]?.playType ?? "power",
        entryCost: resolvedParams.entry,
        riskMode: "safe",
      },
    });
    router.push("/slips");
  };

  // ── Loading / error gates ─────────────────────────────────────────────────
  if (loadingBoard) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-32 text-center">
        <Loader2 size={48} className="text-[#FF3AF2] animate-spin mx-auto" strokeWidth={3} />
        <p className="mt-6 text-white/60 uppercase tracking-widest font-bold text-xs">
          Pulling live PrizePicks board...
        </p>
      </div>
    );
  }

  if (boardError) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <AlertTriangle size={48} className="text-[#F87171] mx-auto" strokeWidth={3} />
        <h1 className="font-[family-name:var(--font-heading)] font-black text-4xl mt-4 text-white">
          Couldn&apos;t reach the board
        </h1>
        <p className="text-white/60 mt-3 text-sm">{boardError}</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      {/* ════════════════════════════════════════════════════════════
          HERO
          ════════════════════════════════════════════════════════════ */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h1 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow">
          Auto-Pilot
        </h1>
        <p className="text-white/70 text-lg mt-3 max-w-3xl">
          No bench needed. Tell us how many lineups you want, we&apos;ll comb the entire
          live board for the highest-probability picks and hand you back ready-to-play slips.
        </p>
        <p className="text-white/40 text-xs mt-2 uppercase tracking-widest font-bold max-w-3xl">
          {filteredCount.toLocaleString()} props in pool ·
          {result && result.realProjectionCount > 0 ? (
            <>
              {" "}<span className="text-[#4ADE80]">{result.realProjectionCount} backed by real game-log Edge</span> ·
              rest use PrizePicks-implied odds
            </>
          ) : (
            <> uses PrizePicks-implied odds (visit live board first to seed real Edge data)</>
          )}
        </p>
      </motion.div>

      {/* ════════════════════════════════════════════════════════════
          MASTER "ALL AUTO" CTA
          The fastest path through this page: leave every knob on Auto and
          hit the button. The card calls that out at the top, and when the
          user IS in all-auto state we show a "live" highlight so they know.
          ════════════════════════════════════════════════════════════ */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className={cn(
          "mt-8 rounded-3xl border-4 p-4 md:p-5 flex flex-wrap items-center gap-4 transition-colors",
          allAuto
            ? "border-[#FFE600] bg-gradient-to-r from-[#FF3AF2]/20 via-[#7B2FFF]/20 to-[#00F5D4]/20"
            : "border-dashed border-white/20 bg-[#2D1B4E]/30",
        )}
      >
        <div
          className={cn(
            "w-12 h-12 rounded-2xl border-4 flex items-center justify-center flex-shrink-0",
            allAuto ? "border-[#FFE600] bg-[#FFE600] text-[#0D0D1A]" : "border-[#FFE600]/60 text-[#FFE600]",
          )}
        >
          <Wand2 size={20} strokeWidth={3} />
        </div>
        <div className="flex-1 min-w-[200px]">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm md:text-base text-white">
            {allAuto ? "All auto — just hit the button" : "Or skip the decisions"}
          </div>
          <div className="text-white/65 text-xs mt-0.5">
            {allAuto
              ? "We'll choose the count, size, sport, and entry for you."
              : "Set every control to Auto and we'll pick the best of everything."}
          </div>
        </div>
        <button
          onClick={setAllAuto}
          disabled={allAuto}
          className={cn(
            "px-5 py-3 rounded-full border-4 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest transition-all",
            allAuto
              ? "border-[#FFE600]/40 text-[#FFE600]/50 cursor-default"
              : "border-[#FFE600] text-[#FFE600] hover:bg-[#FFE600]/10",
          )}
        >
          {allAuto ? "All auto ✓" : "Set all to Auto"}
        </button>
      </motion.div>

      {/* ════════════════════════════════════════════════════════════
          CONTROLS
          ════════════════════════════════════════════════════════════ */}
      <div className="grid lg:grid-cols-[1fr_360px] gap-8 mt-6">
        <div className="space-y-5">
          <ControlCard title="How many lineups?" icon={Trophy} accent="#FFE600" accent2="#FF3AF2">
            <div className="flex flex-wrap gap-3 items-center">
              <AutoPill
                active={lineupCount === "auto"}
                accent="#FFE600"
                onClick={() => setLineupCount("auto")}
              />
              {LINEUP_COUNTS.map((n) => (
                <button
                  key={n}
                  onClick={() => setLineupCount(n)}
                  className={cn(
                    "w-14 h-14 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black text-xl transition-all",
                    n === lineupCount
                      ? "bg-[#FFE600] border-[#FF3AF2] text-[#0D0D1A] shadow-[3px_3px_0_#FF3AF2]"
                      : "border-[#FFE600] text-[#FFE600] hover:bg-[#FFE600]/10",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="text-white/55 text-xs mt-3">
              {lineupCount === "auto" ? (
                <>Auto — we&apos;ll give you {AUTO_COUNT_DEFAULT} distinct slips.</>
              ) : (
                <>
                  We&apos;ll return your top {lineupCount}{" "}
                  {lineupCount === 1 ? "slip" : "slips"} — distinct picks where possible.
                </>
              )}
            </p>
          </ControlCard>

          <ControlCard title="Picks per lineup" icon={Layers} accent="#00F5D4" accent2="#7B2FFF">
            <div className="flex flex-wrap gap-3 items-center">
              <AutoPill
                active={lineupSize === "auto"}
                accent="#00F5D4"
                onClick={() => setLineupSize("auto")}
              />
              {LINEUP_SIZES.map((s) => (
                <button
                  key={s}
                  onClick={() => setLineupSize(s)}
                  className={cn(
                    "w-14 h-14 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black text-xl transition-all",
                    s === lineupSize
                      ? "bg-[#00F5D4] border-[#FF3AF2] text-[#0D0D1A] shadow-[3px_3px_0_#FF3AF2]"
                      : "border-[#00F5D4] text-[#00F5D4] hover:bg-[#00F5D4]/10",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="text-white/55 text-xs mt-3">
              {lineupSize === "auto" ? (
                <>Auto — we&apos;ll sweep 2–6 picks and pick the size with the highest avg $.</>
              ) : (
                <>
                  Smaller slips hit more often but pay less. {lineupSize}-pick base payout:{" "}
                  <span className="text-[#FFE600] font-bold">
                    {POWER_BASE[lineupSize as keyof typeof POWER_BASE] ?? "—"}×
                  </span>{" "}
                  on Power.
                </>
              )}
            </p>
          </ControlCard>

          <ControlCard title="Entry cost" icon={TrendingUp} accent="#FF6B35" accent2="#FFE600">
            <div className="flex flex-wrap gap-3 items-center">
              <AutoPill
                active={entry === "auto"}
                accent="#FF6B35"
                onClick={() => setEntry("auto")}
              />
              {ENTRY_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setEntry(p)}
                  className={cn(
                    "px-5 h-12 rounded-full border-4 font-[family-name:var(--font-heading)] font-black text-lg transition-all",
                    p === entry
                      ? "bg-[#FF6B35] border-[#FFE600] text-[#0D0D1A] shadow-[2px_2px_0_#FFE600]"
                      : "border-[#FF6B35] text-[#FF6B35] hover:bg-[#FF6B35]/15",
                  )}
                >
                  ${p}
                </button>
              ))}
              <input
                type="number"
                value={entry === "auto" ? "" : entry}
                placeholder={entry === "auto" ? `$${AUTO_ENTRY_DEFAULT}` : undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setEntry("auto");
                    return;
                  }
                  setEntry(Math.max(1, Math.min(1000, Number(v) || 0)));
                }}
                className="w-20 h-12 rounded-full border-4 border-dashed border-[#FFE600] bg-transparent px-3 font-[family-name:var(--font-heading)] font-black text-center text-white placeholder:text-white/30 focus:outline-none focus:bg-[#FFE600]/10"
              />
            </div>
            {entry === "auto" && (
              <p className="text-white/55 text-xs mt-3">
                Auto — defaults to ${AUTO_ENTRY_DEFAULT} per slip.
              </p>
            )}
          </ControlCard>

          {leagueOptions.length > 1 && (
            <ControlCard title="Sport filter" icon={Filter} accent="#7B2FFF" accent2="#00F5D4">
              <div className="flex flex-wrap gap-2 items-center">
                <AutoPill
                  active={sport === "auto"}
                  accent="#7B2FFF"
                  onClick={() => setSport("auto")}
                />
                {leagueOptions.map((lg, i) => {
                  const active = sport === lg.name;
                  const accent = accentHexFor(i);
                  return (
                    <button
                      key={lg.name}
                      onClick={() => setSport(lg.name)}
                      className={cn(
                        "px-3 py-2 rounded-full border-[3px] font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-wider transition-all flex items-center gap-1.5",
                        active ? "text-[#0D0D1A]" : "text-white hover:scale-105",
                      )}
                      style={{
                        borderColor: accent,
                        background: active ? accent : "transparent",
                      }}
                    >
                      {lg.name}
                      <span className="text-[10px] opacity-70 font-bold">{lg.count}</span>
                    </button>
                  );
                })}
              </div>
              {sport === "auto" && (
                <p className="text-white/55 text-xs mt-3">
                  Auto — no sport filter, pulls from every league on the board.
                </p>
              )}
            </ControlCard>
          )}
        </div>

        {/* ── Sticky generate panel ── */}
        <aside>
          <div className="sticky top-24 space-y-4">
            <motion.div
              key={`${lineupCount}-${lineupSize}-${entry}`}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="rounded-3xl border-4 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 via-[#7B2FFF]/30 to-[#00F5D4]/30 backdrop-blur-sm p-6"
            >
              <div className="text-white/70 text-[10px] uppercase tracking-widest font-bold">
                You&apos;ll get back
              </div>
              <div className="font-[family-name:var(--font-display)] text-6xl text-[#FFE600] leading-none mt-1 text-shadow-2 flex items-baseline gap-2">
                {lineupCount === "auto" ? AUTO_COUNT_DEFAULT : lineupCount}
                {lineupCount === "auto" && (
                  <span className="font-[family-name:var(--font-heading)] text-xs uppercase tracking-widest text-[#FFE600]/80 font-black">
                    auto
                  </span>
                )}
              </div>
              <div className="text-white/70 text-xs mt-2">
                slips ·{" "}
                {lineupSize === "auto" ? (
                  <span className="text-[#00F5D4] font-bold">auto</span>
                ) : (
                  lineupSize
                )}{" "}
                picks each ·{" "}
                {entry === "auto" ? (
                  <span className="text-[#FF6B35] font-bold">auto</span>
                ) : (
                  <>${entry}</>
                )}{" "}
                entry
              </div>
              <div className="text-white/50 text-[10px] uppercase tracking-widest font-bold mt-3">
                Sport ·{" "}
                {sport === "auto" ? (
                  <span className="text-[#7B2FFF]">auto</span>
                ) : (
                  sport
                )}
              </div>
            </motion.div>

            <button
              onClick={handleGenerate}
              disabled={crunching || !board}
              className={cn(
                "w-full h-16 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4]",
                "font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-lg",
                "flex items-center justify-center gap-3 transition-all",
                "hover:scale-105 active:scale-95",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
                !crunching && board && "animate-(--animate-pulse-glow)",
              )}
            >
              {crunching ? (
                <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                  <Sliders size={22} strokeWidth={3} />
                </motion.span>
              ) : allAuto ? (
                <Wand2 size={22} strokeWidth={3} />
              ) : (
                <Sparkles size={22} strokeWidth={3} />
              )}
              {crunching
                ? "Hunting picks..."
                : allAuto
                  ? "Surprise me"
                  : "Build my lineups"}
            </button>
            <p className="text-center text-white/50 text-xs">
              Ranked by chance to hit · ties broken by avg $ per play.
            </p>
          </div>
        </aside>
      </div>

      {/* ════════════════════════════════════════════════════════════
          RESULTS
          ════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {result && (
          <motion.section
            key="results"
            ref={resultsRef}
            // Beefier entrance — slide up from further down with a spring,
            // and offset the scroll target so the section header doesn't kiss
            // the top of the viewport (scroll-mt-24 ≈ 6rem breathing room).
            initial={{ opacity: 0, y: 60, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ type: "spring", damping: 24, stiffness: 220 }}
            className="mt-14 scroll-mt-24"
          >
            <div className="flex items-end justify-between flex-wrap gap-3 mb-6">
              <div>
                <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-4xl md:text-5xl gradient-text-rainbow">
                  Your auto-picks
                </h2>
                <p className="text-white/55 text-xs mt-2 uppercase tracking-widest font-bold">
                  {result.totalEvaluated.toLocaleString()} combos evaluated in {result.elapsedMs}ms ·
                  pool of {result.poolSize} props
                  {result.realProjectionCount > 0 ? (
                    <> · <span className="text-[#4ADE80]">{result.realProjectionCount} real Edge</span></>
                  ) : null}
                </p>
              </div>
              {result.lineups.length > 0 && (
                <button
                  onClick={handleSendToSlips}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-full border-4 border-[#00F5D4] bg-gradient-to-r from-[#00F5D4] via-[#7B2FFF] to-[#FF3AF2] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-sm hover:scale-105 active:scale-95 transition-transform"
                >
                  Open in leaderboard
                  <ArrowRight size={16} strokeWidth={3} />
                </button>
              )}
            </div>

            {/* "We chose" summary — only shown when at least one knob was on
                Auto, so the user sees what the algorithm resolved each
                auto-value to without having to scroll back up. */}
            {resolvedParams && (
              <ResolvedSummary
                resolved={resolvedParams}
                wasAuto={{
                  count: lineupCount === "auto",
                  size: lineupSize === "auto",
                  entry: entry === "auto",
                  sport: sport === "auto",
                }}
              />
            )}

            {result.lineups.length === 0 ? (
              <EmptyResult
                lineupSize={resolvedParams?.lineupSize ?? 4}
                pool={result.poolSize}
                sport={resolvedParams?.sport ?? "ALL"}
              />
            ) : (
              <div className="grid gap-5">
                {result.lineups.map((l, i) => (
                  <LineupCard
                    key={l.id}
                    lineup={l}
                    index={i}
                    entry={resolvedParams?.entry ?? l.entryCost}
                    onPickClick={(prop) => setInspectedProp(prop)}
                  />
                ))}
              </div>
            )}

            {/* Honest disclosure — these aren't guaranteed, they're highest-probability. */}
            <div className="mt-8 rounded-2xl border-2 border-dashed border-[#FFE600]/40 bg-[#FFE600]/5 p-4 text-white/65 text-xs leading-relaxed">
              <strong className="text-[#FFE600] uppercase tracking-widest text-[10px] font-bold block mb-1.5">
                One thing
              </strong>
              No bet is guaranteed — PrizePicks tunes their lines so house edge holds in the long
              run. We&apos;re showing the lineups with the highest chance to hit given the data we have
              (real game-log projections when cached, PrizePicks-implied otherwise). Visit the
              Live Board first to seed real Edge data for the leagues you want stronger picks in.
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Player detail modal — opens when the user taps any pick row inside
          a generated lineup. Single instance lifted to the page level; the
          row click handlers set `inspectedProp` and the modal reads it.
          MORE / LESS inside the modal goes through useSelectionStore.toggle
          so committing here adds the pick to the user's bench, same as
          tapping a card on the Live Board. */}
      {inspectedProp && (() => {
        // Is this prop already on the bench? If yes, surface its side so
        // the modal pill renders in the "active" state.
        const benchEntry = benchPicks.find((p) => p.propId === inspectedProp.id);
        return (
          <PlayerDetailModal
            open={true}
            onClose={() => setInspectedProp(null)}
            prop={inspectedProp}
            selectedSide={(benchEntry?.side as PickSide | undefined) ?? null}
            onToggleSide={(side) => toggleSelection(inspectedProp, side)}
            moreP={inspectedProp.pMore * 100}
            lessP={inspectedProp.pLess * 100}
          />
        );
      })()}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Internal components
// ══════════════════════════════════════════════════════════════════════

const POWER_BASE: Record<number, number> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 25,
};

/**
 * Auto pill — the "AUTO" chip that lives at the head of every control row.
 * Active state matches the card's accent color so it reads as one of the
 * options, not a separate widget.
 */
function AutoPill({
  active,
  accent,
  onClick,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Let us pick this for you"
      className={cn(
        "h-12 px-4 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest transition-all flex items-center gap-1.5",
        active ? "shadow-[3px_3px_0_#FF3AF2]" : "hover:opacity-90",
      )}
      style={{
        borderColor: active ? "#FF3AF2" : accent,
        background: active ? accent : "transparent",
        color: active ? "#0D0D1A" : accent,
      }}
    >
      <Wand2 size={13} strokeWidth={3} />
      Auto
    </button>
  );
}

function ControlCard({
  title,
  icon: Icon,
  accent,
  accent2,
  children,
}: {
  title: string;
  icon: typeof Sliders;
  accent: string;
  accent2: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", damping: 20 }}
      className="relative rounded-2xl border-4 p-5 backdrop-blur-sm bg-[#2D1B4E]/60"
      style={{ borderColor: accent, boxShadow: `4px 4px 0 ${accent2}` }}
    >
      <div className="flex items-center gap-2 mb-3">
        <div
          className="w-9 h-9 rounded-xl border-4 flex items-center justify-center"
          style={{ borderColor: accent2, color: accent }}
        >
          <Icon size={16} strokeWidth={3} />
        </div>
        <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-lg">
          {title}
        </h2>
      </div>
      {children}
    </motion.div>
  );
}

function LineupCard({
  lineup,
  index,
  entry,
  onPickClick,
}: {
  lineup: import("@/lib/types").Lineup;
  index: number;
  entry: number;
  /** Tap handler for individual pick rows — opens the player-detail modal
   *  (same one the Live Board uses) at the page level so the user can see
   *  last-5 chart, projection line, etc. without losing their lineup view. */
  onPickClick: (prop: Prop) => void;
}) {
  const accent = accentHexFor(index);
  const accent2 = accentHexFor(index + 2);
  const pctColor =
    lineup.hitProbability >= 0.25
      ? "#4ADE80"
      : lineup.hitProbability >= 0.10
        ? "#FFE600"
        : "#F87171";
  const evColor = lineup.expectedValue >= 0 ? "#4ADE80" : "#F87171";

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", damping: 22, delay: index * 0.04 }}
      className="rounded-3xl border-4 bg-[#0D0D1A]/70 backdrop-blur-sm overflow-hidden"
      style={{ borderColor: accent, boxShadow: `5px 5px 0 ${accent2}` }}
    >
      {/* Header — title row, then a stat strip below. On desktop the
          stat strip flattens into one row via `md:contents`, which lets the
          title and stats sit on the same grid line. */}
      <div
        className="grid gap-3 md:gap-5 p-5 items-center border-b-4 border-dashed md:grid-cols-[auto_1fr_auto_auto_auto]"
        style={{ borderColor: `${accent}55` }}
      >
        <div className="flex items-center gap-3 md:contents">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center font-[family-name:var(--font-display)] text-2xl text-[#0D0D1A] flex-shrink-0"
            style={{ background: accent }}
          >
            #{index + 1}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-xs text-white/55">
              {lineup.picks.length}-pick · {lineup.playType === "power" ? "Power (all hit)" : "Flex (partial OK)"}
            </div>
            <div className="text-white text-sm mt-0.5">
              {lineup.payoutMultiplier.toFixed(2)}× payout · pays{" "}
              <span className="text-[#00F5D4] font-bold">${lineup.grossPayout.toFixed(0)}</span> if it lands
            </div>
            <div
              className="text-white/40 text-[10px] mt-1 uppercase tracking-widest font-bold"
              title="PrizePicks Reversion contests offer a 1st-place tournament prize on top of this — that's upside we can't predict, so it's not included here."
            >
              Min guarantee · contest 1st-place bonus not included
            </div>
          </div>
        </div>

        {/* Mobile: 3-column stat strip below the title. Desktop: each Stat
            lands in its own grid column thanks to the `md:contents` above. */}
        <div className="grid grid-cols-3 gap-2 md:contents">
          <Stat label="Hit %" accent={pctColor}>
            <AnimatedPercent value={lineup.hitProbability} decimals={1} className="font-[family-name:var(--font-display)] text-2xl md:text-4xl leading-none" />
          </Stat>
          <Stat label="Avg $" accent={evColor}>
            <span style={{ color: evColor }} className="font-[family-name:var(--font-display)] text-2xl md:text-4xl leading-none">
              {lineup.expectedValue >= 0 ? "+" : ""}${lineup.expectedValue.toFixed(2)}
            </span>
          </Stat>
          <Stat label="Pays" accent="#FFE600">
            <span className="font-[family-name:var(--font-display)] text-2xl md:text-4xl text-white leading-none">
              ${lineup.grossPayout.toFixed(0)}
            </span>
          </Stat>
        </div>
      </div>

      {/* Picks — each row is interactive; tap opens the player-detail
          modal at the page level (last-5 chart, projection line, MORE/LESS
          toggle that drops into the bench). */}
      <ul className="grid gap-2 p-5">
        {lineup.picks.map((p, i) => {
          const isMore = p.side === "more";
          const sideColor = isMore ? "#4ADE80" : "#F87171";
          const SideIcon = isMore ? TrendingUp : TrendingDown;
          return (
            <li
              key={p.prop.id}
              role="button"
              tabIndex={0}
              onClick={() => onPickClick(p.prop)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPickClick(p.prop);
                }
              }}
              aria-label={`Open details for ${p.prop.playerName} ${p.prop.statType} ${isMore ? "more" : "less"} ${p.prop.line}`}
              className={cn(
                "grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-white/10 bg-[#2D1B4E]/40 px-3 py-2.5",
                "cursor-pointer hover:border-white/30 hover:bg-[#2D1B4E]/70 transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D0D1A] focus-visible:ring-[#FFE600]",
              )}
            >
              <span
                className="w-7 h-7 rounded-full border-2 flex items-center justify-center font-[family-name:var(--font-display)] text-xs text-white/85"
                style={{ borderColor: sideColor }}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tight text-white text-sm md:text-base leading-tight">
                  {p.prop.playerName}
                </div>
                <div className="text-white/55 text-[10px] md:text-[11px] uppercase tracking-widest font-bold flex items-center gap-1 md:gap-1.5 flex-wrap mt-0.5">
                  <span>{p.prop.statType}</span>
                  <span>·</span>
                  <span className="text-white/75">{isMore ? "More" : "Less"} {p.prop.line}</span>
                  <span className="hidden md:inline">·</span>
                  <span className="hidden md:inline">{p.prop.sport}</span>
                  {p.prop.oddsType !== "standard" && (
                    <>
                      <span>·</span>
                      <OddsBadge oddsType={p.prop.oddsType} compact />
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px]"
                  style={{ backgroundColor: `${sideColor}20`, color: sideColor, border: `1px solid ${sideColor}` }}
                >
                  <SideIcon size={11} strokeWidth={3} />
                  {isMore ? "More" : "Less"}
                </span>
                <span
                  className="font-[family-name:var(--font-display)] text-lg w-12 text-right"
                  style={{ color: sideColor }}
                >
                  {(p.probability * 100).toFixed(0)}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="px-5 pb-5 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-white/45 text-[10px] uppercase tracking-widest font-bold">
          Entry ${entry} · {lineup.correlationRisk === "low" ? "picks independent" : lineup.correlationRisk === "medium" ? "some overlap" : "lots of overlap"}
        </span>
        <CopyPicksButton lineup={lineup} entry={entry} />
      </div>
    </motion.article>
  );
}

/**
 * Compact "Copy picks" button — formats the lineup into a plain-text block
 * the user can paste into a notes app, Discord, or PrizePicks itself if
 * they're transcribing manually. Uses the Clipboard API; falls back to a
 * legacy execCommand path so it still works on iOS Safari < 13.4 and
 * non-secure-context dev URLs.
 *
 * Visual state cycles: idle → copied (1.5s) → idle. We swap the icon and
 * label rather than firing a toast — keeps the action local to the row
 * the user clicked, no full-page interruption.
 */
function CopyPicksButton({
  lineup,
  entry,
}: {
  lineup: import("@/lib/types").Lineup;
  entry: number;
}) {
  const [copied, setCopied] = useState(false);

  const formatted = (() => {
    const pickLines = lineup.picks.map((p, i) => {
      const side = p.side === "more" ? "MORE" : "LESS";
      const oddsTag = p.prop.oddsType !== "standard" ? ` (${p.prop.oddsType.toUpperCase()})` : "";
      const pct = `${(p.probability * 100).toFixed(0)}%`;
      return `${i + 1}. ${p.prop.playerName} — ${p.prop.statType} ${side} ${p.prop.line}${oddsTag} · ${pct}`;
    });
    const sizeLabel = `${lineup.picks.length}-pick ${lineup.playType === "power" ? "Power" : "Flex"}`;
    const hit = `${(lineup.hitProbability * 100).toFixed(1)}% hit`;
    const pays = `$${lineup.grossPayout.toFixed(0)} if it lands`;
    return `${pickLines.join("\n")}\n\n${sizeLabel} · ${hit} · ${pays} · $${entry} entry`;
  })();

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(formatted);
      } else {
        // Legacy fallback — iOS Safari < 13.4 / non-secure contexts.
        const ta = document.createElement("textarea");
        ta.value = formatted;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silently no-op on failure — the user can still select + copy manually
      // from the open detail modal if this fails.
    }
  };

  return (
    <button
      onClick={copy}
      aria-label={copied ? "Picks copied to clipboard" : "Copy picks to clipboard"}
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px] transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D0D1A] focus-visible:ring-[#FFE600]",
        copied
          ? "border-[#4ADE80] bg-[#4ADE80]/15 text-[#4ADE80]"
          : "border-white/20 text-white/70 hover:text-white hover:border-white/50 hover:bg-white/5",
      )}
    >
      {copied ? (
        <>
          <Check size={12} strokeWidth={3} aria-hidden />
          Copied
        </>
      ) : (
        <>
          <Copy size={12} strokeWidth={3} aria-hidden />
          Copy picks
        </>
      )}
    </button>
  );
}

function Stat({
  label,
  accent,
  children,
}: {
  label: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="text-center">
      <div
        className="text-[9px] uppercase tracking-widest font-bold mb-1"
        style={{ color: accent }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * Compact strip shown above the lineup list whenever any control was on
 * Auto. Each chip shows the resolved value with a wand icon on the ones
 * that were actually chosen by the algorithm. When nothing was on auto,
 * the parent simply doesn't render this.
 */
function ResolvedSummary({
  resolved,
  wasAuto,
}: {
  resolved: { lineupCount: number; lineupSize: number; entry: number; sport: string };
  wasAuto: { count: boolean; size: boolean; entry: boolean; sport: boolean };
}) {
  const anyAuto = wasAuto.count || wasAuto.size || wasAuto.entry || wasAuto.sport;
  if (!anyAuto) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6 rounded-2xl border-2 border-dashed border-[#FFE600]/40 bg-[#FFE600]/5 p-3 md:p-4 flex flex-wrap items-center gap-2 md:gap-3"
    >
      <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px] text-[#FFE600] flex items-center gap-1.5">
        <Wand2 size={12} strokeWidth={3} />
        We chose
      </span>
      <ResolvedChip label={`${resolved.lineupCount} ${resolved.lineupCount === 1 ? "slip" : "slips"}`} auto={wasAuto.count} accent="#FFE600" />
      <ResolvedChip label={`${resolved.lineupSize}-pick`} auto={wasAuto.size} accent="#00F5D4" />
      <ResolvedChip label={`$${resolved.entry}`} auto={wasAuto.entry} accent="#FF6B35" />
      <ResolvedChip label={resolved.sport === "ALL" ? "All sports" : resolved.sport} auto={wasAuto.sport} accent="#7B2FFF" />
    </motion.div>
  );
}

function ResolvedChip({
  label,
  auto,
  accent,
}: {
  label: string;
  auto: boolean;
  accent: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase text-[10px] tracking-widest"
      style={{
        borderColor: accent,
        color: auto ? "#0D0D1A" : accent,
        background: auto ? accent : "transparent",
      }}
    >
      {auto && <Wand2 size={10} strokeWidth={3} />}
      {label}
    </span>
  );
}

function EmptyResult({
  lineupSize,
  pool,
  sport,
}: {
  lineupSize: number;
  pool: number;
  sport: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="rounded-3xl border-4 border-dashed border-[#F87171] bg-[#F87171]/10 p-8 text-center"
    >
      <Zap size={36} className="text-[#F87171] mx-auto" strokeWidth={3} />
      <h3 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-lg text-white mt-3">
        No lineups available
      </h3>
      <p className="text-white/65 text-sm mt-2 max-w-md mx-auto">
        Pool of {pool} {sport === "ALL" ? "" : `${sport} `}props can&apos;t form a {lineupSize}-pick
        slip with two different teams. Try a different sport, a smaller lineup size, or wait
        for more games to come on the board.
      </p>
    </motion.div>
  );
}
