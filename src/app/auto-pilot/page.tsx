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
  Wallet,
  Loader2,
  AlertTriangle,
  Wand2,
  Copy,
  Check,
  Ghost,
  Flame,
  Scale,
} from "lucide-react";
import type { OddsPreference } from "@/lib/autoPilot";
import { buildAutoLineups, pickAutoSize, recommendLineupCount, type AutoPilotResult } from "@/lib/autoPilot";
import { useProjectionStore } from "@/stores/projectionStore";
import { useLineupStore } from "@/stores/lineupStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { OddsBadge } from "@/components/OddsBadge";
import { PlayerDetailModal } from "@/components/PlayerDetailModal";
import { AutoPilotChat } from "@/components/AutoPilotChat";
import { accentHexFor, cn } from "@/lib/cn";
import type { LeagueSummary, PickSide, Prop } from "@/lib/types";

const ENTRY_PRESETS = [5, 10, 20, 50, 100] as const;
const MAX_SPEND_PRESETS = [10, 25, 50, 100, 200] as const;
const LINEUP_SIZES = [2, 3, 4, 5, 6] as const;
const LINEUP_COUNTS = [1, 2, 3, 4, 5] as const;

/** Pick-style choices for the "What do you lean toward?" control. Each maps to
 *  an OddsPreference the optimizer honors when ranking + choosing variants. */
const ODDS_PREFERENCES: {
  value: OddsPreference;
  label: string;
  blurb: string;
  icon: typeof Ghost;
  accent: string;
}[] = [
  { value: "balanced", label: "Balanced", blurb: "Let the model pick the best style per player.", icon: Scale, accent: "#FFE600" },
  { value: "goblin", label: "Green goblins", blurb: "Easier lines — hit more often, smaller payout.", icon: Ghost, accent: "#4ADE80" },
  { value: "demon", label: "Red demons", blurb: "Harder lines — bigger payout, lower hit rate.", icon: Flame, accent: "#F87171" },
  { value: "standard", label: "Standard", blurb: "Plain over/under lines only — no goblins or demons.", icon: TrendingUp, accent: "#00F5D4" },
];

/**
 * Defaults / bounds used whenever a control is left on "auto":
 *   count → model-decided at build time (1..MAX_AUTO_LINEUPS) via
 *           recommendLineupCount, capped by Max Spend
 *   size  → resolved at run-time by pickAutoSize() against the live board
 *   entry → $20 (PrizePicks median single-slip ticket)
 *   sport → ALL (no filter — auto = "we choose")
 */
const AUTO_ENTRY_DEFAULT = 20;
// PrizePicks-style minimum per-slip entry. Auto entry never goes below this.
const MIN_AUTO_ENTRY = 5;
// Ceiling the model may use when count is on Auto. It builds up to this many
// distinct slips, then keeps only the ones genuinely worth playing (see
// recommendLineupCount) — so Auto returns 1 when there is one standout and more
// only when several are real, never padding to a fixed number.
const MAX_AUTO_LINEUPS = 5;

/**
 * Auto entry-cost. $20 per slip by default, but LOWERED to fit a Max Spend cap
 * so a small cap still builds a slip instead of blocking the whole thing.
 * (Before this, Auto entry stayed $20 and a $10 cap just showed "Over budget"
 * forever — the bug this fixes.) Never drops below the $5 minimum; if the cap is
 * under $5 the build genuinely can't fit and the panel says so.
 */
function autoEntryForCap(cap: number | null): number {
  if (cap == null) return AUTO_ENTRY_DEFAULT;
  return Math.min(AUTO_ENTRY_DEFAULT, Math.max(MIN_AUTO_ENTRY, cap));
}
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
  const fetchProjection = useProjectionStore((s) => s.fetchOne);

  // Playoffs-only filter — pulled from settings + the live playoff cache.
  // When the user has flipped this on, we ask the warmup endpoint for the
  // current alive-team set and pass it as a hard allowlist to the
  // optimizer. Empty allowlist = no filter (graceful fallback when the
  // cache hasn't been warmed yet).
  const playoffsOnly = useSettingsStore((s) => s.playoffsOnly);
  // Pick-style preference (green goblins / red demons / standard / balanced).
  // Persisted in settings so it carries across pages + the budget chat.
  const oddsPreference = useSettingsStore((s) => s.oddsPreference);
  const setOddsPreference = useSettingsStore((s) => s.setOddsPreference);
  // "Favor consistent players" — standing safer-bets default; weights low-
  // variance players up in the candidate ranking.
  const favorConsistency = useSettingsStore((s) => s.favorConsistency);
  const setFavorConsistency = useSettingsStore((s) => s.setFavorConsistency);
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
  // Max total spend cap. "auto" = no cap. When set, the build trims the
  // number of lineups so (count × entry) never exceeds it.
  const [maxSpend, setMaxSpend] = useState<AutoOr<number>>("auto");
  const [sport, setSport] = useState<AutoOr<string>>("auto");
  const [crunching, setCrunching] = useState(false);
  const [pricingPicks, setPricingPicks] = useState(false);
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
    maxSpend === "auto" &&
    sport === "auto";

  const setAllAuto = () => {
    setLineupCount("auto");
    setLineupSize("auto");
    setEntry("auto");
    setMaxSpend("auto");
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

  // Sport pills. Collapsed to the top 8 by count to keep the row tidy; the
  // "show all" toggle reveals every league — including segment props like
  // NBA1Q / NBA2H / WNBA4Q that otherwise fall outside the top 8.
  const [showAllLeagues, setShowAllLeagues] = useState(false);
  const leagueOptions = useMemo<LeagueSummary[]>(() => {
    if (!board) return [];
    const shown = showAllLeagues ? board.leagues : board.leagues.slice(0, 8);
    return [{ name: "ALL", count: board.total }, ...shown];
  }, [board, showAllLeagues]);
  const hiddenLeagueCount = board ? Math.max(0, board.leagues.length - 8) : 0;

  // ── Spend math ─────────────────────────────────────────────────────────
  // Total spend = lineups × per-slip entry. The Max Spend cap (when set) trims
  // the lineup count so we never exceed it; if even one slip can't fit under
  // the cap, the build is blocked. Resolves "auto" knobs to their defaults so
  // the panel always shows a concrete dollar figure.
  const spend = useMemo(() => {
    // On Auto the model decides the real count at build time (1..ceiling), so
    // the preview shows the ceiling as an upper bound ("up to"). With an
    // explicit count it is exact.
    const autoCount = lineupCount === "auto";
    const requested = autoCount ? MAX_AUTO_LINEUPS : lineupCount;
    const cap = maxSpend === "auto" ? null : maxSpend;
    // Auto entry fits the cap (drops from $20 so a small cap still builds).
    const effEntry = entry === "auto" ? autoEntryForCap(cap) : entry;
    const fitCount = cap != null ? Math.floor(cap / effEntry) : requested;
    const cantFit = cap != null && fitCount < 1;
    const finalCount = cap != null ? Math.max(0, Math.min(requested, fitCount)) : requested;
    return {
      autoCount,
      effCount: finalCount,
      effEntry,
      cap,
      plannedTotal: requested * effEntry,
      finalCount,
      finalTotal: finalCount * effEntry,
      trimmed: cap != null && finalCount < requested && !cantFit,
      cantFit,
    };
  }, [lineupCount, entry, maxSpend]);

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
      oddsPreference,
      favorConsistency,
    };
    // Resolve entry + count, then apply the Max Spend cap by trimming the
    // lineup count so count × entry never exceeds it.
    const cap = maxSpend === "auto" ? null : maxSpend;
    // Auto entry fits the cap (drops from $20 so a small cap still builds one
    // slip instead of blocking). An explicit entry is used as-is.
    const baseEntry = entry === "auto" ? autoEntryForCap(cap) : entry;
    const isAutoCount = lineupCount === "auto";
    // When the user explicitly picked a count, fill to it (allow overlap on a
    // thin board). On Auto we never pad — fewer-but-distinct is the whole point.
    const fillToCount = !isAutoCount;
    // Build ceiling: how many slips the optimizer may produce before the model
    // trims to the ones worth playing. On Auto that is up to MAX_AUTO_LINEUPS;
    // with an explicit count it is that count. Max Spend caps it either way so
    // count × entry can never exceed the cap.
    const requested = isAutoCount ? MAX_AUTO_LINEUPS : lineupCount;
    const buildCeiling =
      cap != null ? Math.max(0, Math.min(requested, Math.floor(cap / baseEntry))) : requested;
    // Guard: per-slip entry alone exceeds the cap — nothing fits, so bail
    // (the Build button is disabled in this state; this is belt-and-suspenders).
    if (buildCeiling < 1) {
      setCrunching(false);
      return;
    }
    const resolved = {
      lineupCount: buildCeiling,
      lineupSize:
        lineupSize === "auto" ? pickAutoSize(board.props, optionsForSizing) : lineupSize,
      entry: baseEntry,
      sport: resolvedSport,
    };

    const r = buildAutoLineups(
      board.props,
      resolved.lineupSize,
      resolved.lineupCount,
      resolved.entry,
      { sport: resolved.sport, realProjections: byProp, teamAllowlist: allowlist, oddsPreference, fillToCount, favorConsistency },
    );

    // Warm REAL calibrated projections (game-log model + isotonic calibration)
    // for the handful of props that actually landed in these lineups, then
    // re-score — so the displayed hit/profit/EV reflect the live model instead
    // of PrizePicks-implied placeholders. Bounded to the picks shown (not the
    // whole pool), fetched at the store's 3-at-a-time cap. Props the model
    // can't price (ESPN gamelog unavailable) keep their implied fallback.
    let finalResult = r;
    const distinct = new Map<string, Prop>();
    for (const l of r.lineups) for (const pk of l.picks) distinct.set(pk.prop.id, pk.prop);
    if (distinct.size > 0) {
      setPricingPicks(true);
      try {
        await Promise.all([...distinct.values()].map((p) => fetchProjection(p)));
        const fresh = useProjectionStore.getState().byProp;
        finalResult = buildAutoLineups(
          board.props,
          resolved.lineupSize,
          resolved.lineupCount,
          resolved.entry,
          { sport: resolved.sport, realProjections: fresh, teamAllowlist: allowlist, oddsPreference, fillToCount, favorConsistency },
        );
      } catch {
        /* keep the implied-priced result if warming fails */
      } finally {
        setPricingPicks(false);
      }
    }

    // Model-driven COUNT. On Auto, keep only the slips the model judges worth
    // playing — recommendLineupCount returns 1 when there is a single standout
    // and more only when several are genuinely comparable, capped by the build
    // ceiling. This makes Auto "what the model thinks is best, whether that is
    // 1 slip or 5" instead of a hardcoded number. Explicit counts pass through.
    if (isAutoCount) {
      const n = recommendLineupCount(finalResult.lineups, buildCeiling);
      finalResult = { ...finalResult, lineups: finalResult.lineups.slice(0, n) };
      resolved.lineupCount = n;
    }

    setResult(finalResult);
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
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-12">
        <div className="max-w-2xl mx-auto text-center">
          <AlertTriangle size={48} className="text-[#F87171] mx-auto" strokeWidth={3} />
          <h1 className="font-[family-name:var(--font-heading)] font-black text-4xl mt-4 text-white">
            Couldn&apos;t reach the board
          </h1>
          <p className="text-white/60 mt-3 text-sm">{boardError}</p>
          <div className="mt-10 flex items-center gap-3 text-white/40 text-[10px] uppercase tracking-widest font-bold">
            <span className="flex-1 h-[1px] bg-white/10" />
            <span>but you can still score your own picks</span>
            <span className="flex-1 h-[1px] bg-white/10" />
          </div>
        </div>
        <div className="mt-8">
          <AutoPilotChat board={board} />
        </div>
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
                <>
                  Auto — the model builds only the slips it judges worth playing
                  (1 to {MAX_AUTO_LINEUPS}), capped by Max Spend. One standout returns one slip.
                </>
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
                Auto — ${AUTO_ENTRY_DEFAULT} per slip, automatically lowered to fit your Max Spend cap.
              </p>
            )}
          </ControlCard>

          <ControlCard title="Max spend" icon={Wallet} accent="#4ADE80" accent2="#00F5D4">
            <div className="flex flex-wrap gap-3 items-center">
              <AutoPill
                active={maxSpend === "auto"}
                accent="#4ADE80"
                onClick={() => setMaxSpend("auto")}
              />
              {MAX_SPEND_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setMaxSpend(p)}
                  className={cn(
                    "px-5 h-12 rounded-full border-4 font-[family-name:var(--font-heading)] font-black text-lg transition-all",
                    p === maxSpend
                      ? "bg-[#4ADE80] border-[#00F5D4] text-[#0D0D1A] shadow-[2px_2px_0_#00F5D4]"
                      : "border-[#4ADE80] text-[#4ADE80] hover:bg-[#4ADE80]/15",
                  )}
                >
                  ${p}
                </button>
              ))}
              <input
                type="number"
                value={maxSpend === "auto" ? "" : maxSpend}
                placeholder="No cap"
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setMaxSpend("auto");
                    return;
                  }
                  setMaxSpend(Math.max(1, Math.min(10000, Number(v) || 0)));
                }}
                className="w-24 h-12 rounded-full border-4 border-dashed border-[#4ADE80] bg-transparent px-3 font-[family-name:var(--font-heading)] font-black text-center text-white placeholder:text-white/30 focus:outline-none focus:bg-[#4ADE80]/10"
              />
            </div>
            <p className="text-white/55 text-xs mt-3">
              {maxSpend === "auto" ? (
                <>Auto — no cap. You spend lineups × entry (${spend.plannedTotal} right now).</>
              ) : spend.cantFit ? (
                <span className="text-[#F87171]">
                  {entry === "auto" ? (
                    <>${maxSpend} cap is below the ${MIN_AUTO_ENTRY} minimum per slip — raise the cap.</>
                  ) : (
                    <>
                      ${maxSpend} cap is below the ${spend.effEntry} per-slip entry — lower the entry
                      or raise the cap.
                    </>
                  )}
                </span>
              ) : spend.trimmed ? (
                <>
                  ${maxSpend} cap — trimmed to{" "}
                  <span className="text-[#4ADE80] font-bold">
                    {spend.finalCount} {spend.finalCount === 1 ? "slip" : "slips"}
                  </span>{" "}
                  so total stays ${spend.finalTotal}.
                </>
              ) : (
                <>${maxSpend} cap — current plan fits (${spend.plannedTotal} total).</>
              )}
            </p>
          </ControlCard>

          <ControlCard title="What do you lean toward?" icon={Ghost} accent="#FF3AF2" accent2="#FFE600">
            <div className="grid grid-cols-2 gap-3">
              {ODDS_PREFERENCES.map((opt) => {
                const active = oddsPreference === opt.value;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setOddsPreference(opt.value)}
                    className={cn(
                      "flex items-start gap-3 rounded-2xl border-4 p-3 text-left transition-all",
                      active ? "text-[#0D0D1A]" : "text-white hover:bg-white/5",
                    )}
                    style={{
                      borderColor: opt.accent,
                      background: active ? opt.accent : "transparent",
                    }}
                  >
                    <Icon size={20} strokeWidth={3} className="flex-shrink-0 mt-0.5" />
                    <span className="min-w-0">
                      <span className="block font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xs">
                        {opt.label}
                      </span>
                      <span className={cn("block text-[10px] mt-0.5 leading-tight", active ? "text-[#0D0D1A]/75" : "text-white/55")}>
                        {opt.blurb}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {oddsPreference === "demon" && (
              <p className="text-[#F87171] text-xs mt-3 flex items-start gap-1.5">
                <Flame size={13} strokeWidth={3} className="flex-shrink-0 mt-0.5" />
                Heads up: demons are built to hit under ~45% of the time. You&apos;re trading hit
                rate for payout — profit % on these lineups will read lower on purpose.
              </p>
            )}

            {/* Safer-bets toggle: weight low-variance (consistent) players up. */}
            <button
              onClick={() => setFavorConsistency(!favorConsistency)}
              className={cn(
                "mt-4 w-full flex items-center gap-3 rounded-2xl border-4 p-3 text-left transition-all",
                favorConsistency ? "border-[#4ADE80] bg-[#4ADE80]/10" : "border-white/15 hover:bg-white/5",
              )}
            >
              <span
                className={cn(
                  "w-11 h-7 rounded-full flex items-center transition-all flex-shrink-0 px-0.5",
                  favorConsistency ? "bg-[#4ADE80] justify-end" : "bg-white/20 justify-start",
                )}
              >
                <span className="w-6 h-6 rounded-full bg-white block" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xs text-white">
                  <Scale size={14} strokeWidth={3} className="text-[#4ADE80]" />
                  Favor consistent players
                </span>
                <span className="block text-[10px] text-white/55 mt-0.5 leading-tight">
                  {favorConsistency
                    ? "On — steady, low-variance players are weighted above boom-or-bust ones for safer slips."
                    : "Off — picks are ranked by hit probability alone, regardless of how volatile the player is."}
                </span>
              </span>
            </button>
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
                {hiddenLeagueCount > 0 && (
                  <button
                    onClick={() => setShowAllLeagues((v) => !v)}
                    className="px-3 py-2 rounded-full border-[3px] border-dashed border-white/30 text-white/70 hover:text-white hover:border-white/60 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-wider transition-all"
                  >
                    {showAllLeagues ? "Show less" : `+${hiddenLeagueCount} more (2H · 1Q · periods…)`}
                  </button>
                )}
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
                {spend.autoCount ? `≤${spend.finalCount}` : lineupCount}
                {spend.autoCount && (
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

              {/* Total spend — the number the page used to hide. Reflects the
                  Max Spend cap: shows the capped total, with the pre-cap amount
                  struck alongside when we trimmed lineups to fit. */}
              <div className="mt-3 pt-3 border-t border-white/15">
                <div className="text-white/70 text-[10px] uppercase tracking-widest font-bold">
                  Total spend
                </div>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span
                    className={cn(
                      "font-[family-name:var(--font-display)] text-4xl leading-none",
                      spend.cantFit ? "text-[#F87171]" : "text-[#4ADE80]",
                    )}
                  >
                    ${spend.finalTotal}
                  </span>
                  {spend.trimmed && (
                    <span className="text-white/40 text-xs line-through">${spend.plannedTotal}</span>
                  )}
                </div>
                <div className="text-white/45 text-[10px] mt-1">
                  {spend.cantFit ? (
                    <span className="text-[#F87171]">
                      ${spend.effEntry} entry exceeds the ${spend.cap} cap
                    </span>
                  ) : (
                    <>
                      {spend.autoCount && "up to "}
                      {spend.finalCount} {spend.finalCount === 1 ? "slip" : "slips"} × $
                      {spend.effEntry}
                      {spend.cap != null && <> · cap ${spend.cap}</>}
                    </>
                  )}
                </div>
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
              disabled={crunching || !board || spend.cantFit}
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
                ? pricingPicks
                  ? "Pricing picks with the live model…"
                  : "Hunting picks..."
                : spend.cantFit
                  ? "Over budget"
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

      {/* Budget chat — user types a budget + intent in plain English, the
          chat parses it and runs the optimizer at a few entry sizes to
          propose a concrete spend plan. Standalone from the auto-pilot
          flow above; complements rather than replaces it. */}
      <div className="mt-12">
        <AutoPilotChat board={board} />
      </div>
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
  // Honest "chance you actually profit" — excludes the Flex bottom tier that
  // cashes but still loses money (e.g. 3/5 → 0.4×). Equals hitProbability for
  // Power (all-or-nothing); falls back to it for any lineup without the field.
  const profitProb = lineup.probProfit ?? lineup.hitProbability;
  const pctColor =
    profitProb >= 0.25
      ? "#4ADE80"
      : profitProb >= 0.10
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
          <Stat label="Profit %" accent={pctColor}>
            <span
              style={{ color: pctColor }}
              className="font-[family-name:var(--font-display)] text-2xl md:text-4xl leading-none"
            >
              {(profitProb * 100).toFixed(1)}%
            </span>
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
    const hit = `${((lineup.probProfit ?? lineup.hitProbability) * 100).toFixed(1)}% profit chance`;
    const pays = `$${lineup.grossPayout.toFixed(0)} best case`;
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
