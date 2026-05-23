"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { buildAutoLineups, type AutoPilotResult } from "@/lib/autoPilot";
import { useProjectionStore } from "@/stores/projectionStore";
import { useLineupStore } from "@/stores/lineupStore";
import { OddsBadge } from "@/components/OddsBadge";
import { AnimatedPercent } from "@/components/AnimatedPercent";
import { accentHexFor, cn } from "@/lib/cn";
import type { LeagueSummary, Prop } from "@/lib/types";

const ENTRY_PRESETS = [5, 10, 20, 50, 100] as const;
const LINEUP_SIZES = [2, 3, 4, 5, 6] as const;
const LINEUP_COUNTS = [1, 2, 3, 4, 5] as const;

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

  const [board, setBoard] = useState<ApiResponse | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [boardError, setBoardError] = useState<string | null>(null);

  // Controls
  const [lineupCount, setLineupCount] = useState<number>(3);
  const [lineupSize, setLineupSize] = useState<number>(4);
  const [entry, setEntry] = useState<number>(20);
  const [sport, setSport] = useState<string>("ALL");
  const [crunching, setCrunching] = useState(false);
  const [result, setResult] = useState<AutoPilotResult | null>(null);

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
  // pre-flight number so the user knows what pool we're searching.
  const filteredCount = useMemo(() => {
    if (!board) return 0;
    if (sport === "ALL") return board.total;
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
    const r = buildAutoLineups(board.props, lineupSize, lineupCount, entry, {
      sport,
      realProjections: byProp,
    });
    setResult(r);
    setCrunching(false);
  };

  // Push the generated lineups into the slip store and jump to the
  // leaderboard view — same shape the Optimizer page uses, so /slips
  // renders them without any special-casing.
  const handleSendToSlips = () => {
    if (!result || result.lineups.length === 0) return;
    setLineupResults({
      lineups: result.lineups,
      totalGenerated: result.totalEvaluated,
      elapsedMs: result.elapsedMs,
      params: {
        lineupSize,
        playType: result.lineups[0]?.playType ?? "power",
        entryCost: entry,
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
          CONTROLS
          ════════════════════════════════════════════════════════════ */}
      <div className="grid lg:grid-cols-[1fr_360px] gap-8 mt-10">
        <div className="space-y-5">
          <ControlCard title="How many lineups?" icon={Trophy} accent="#FFE600" accent2="#FF3AF2">
            <div className="flex flex-wrap gap-3">
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
              We&apos;ll return your top {lineupCount} {lineupCount === 1 ? "slip" : "slips"} — distinct
              picks where possible so it isn&apos;t the same lineup five times.
            </p>
          </ControlCard>

          <ControlCard title="Picks per lineup" icon={Layers} accent="#00F5D4" accent2="#7B2FFF">
            <div className="flex flex-wrap gap-3">
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
              Smaller slips hit more often but pay less. {lineupSize}-pick base payout:{" "}
              <span className="text-[#FFE600] font-bold">
                {POWER_BASE[lineupSize as keyof typeof POWER_BASE] ?? "—"}×
              </span>{" "}
              on Power.
            </p>
          </ControlCard>

          <ControlCard title="Entry cost" icon={TrendingUp} accent="#FF6B35" accent2="#FFE600">
            <div className="flex flex-wrap gap-3">
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
                value={entry}
                onChange={(e) => setEntry(Math.max(1, Math.min(1000, Number(e.target.value) || 0)))}
                className="w-20 h-12 rounded-full border-4 border-dashed border-[#FFE600] bg-transparent px-3 font-[family-name:var(--font-heading)] font-black text-center text-white focus:outline-none focus:bg-[#FFE600]/10"
              />
            </div>
          </ControlCard>

          {leagueOptions.length > 1 && (
            <ControlCard title="Sport filter" icon={Filter} accent="#7B2FFF" accent2="#00F5D4">
              <div className="flex flex-wrap gap-2">
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
              <div className="font-[family-name:var(--font-display)] text-6xl text-[#FFE600] leading-none mt-1 text-shadow-2">
                {lineupCount}
              </div>
              <div className="text-white/70 text-xs mt-2">
                slips · {lineupSize} picks each · ${entry} entry
              </div>
              <div className="text-white/50 text-[10px] uppercase tracking-widest font-bold mt-3">
                Max if all hit · ${(entry * (POWER_BASE[lineupSize as keyof typeof POWER_BASE] ?? 0) * lineupCount).toFixed(0)} total
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
              ) : (
                <Sparkles size={22} strokeWidth={3} />
              )}
              {crunching ? "Hunting picks..." : "Build my lineups"}
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
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", damping: 22 }}
            className="mt-14"
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

            {result.lineups.length === 0 ? (
              <EmptyResult lineupSize={lineupSize} pool={result.poolSize} sport={sport} />
            ) : (
              <div className="grid gap-5">
                {result.lineups.map((l, i) => (
                  <LineupCard key={l.id} lineup={l} index={i} entry={entry} />
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
}: {
  lineup: import("@/lib/types").Lineup;
  index: number;
  entry: number;
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
      {/* Header row */}
      <div
        className="grid grid-cols-[auto_1fr] md:grid-cols-[auto_1fr_auto_auto_auto] gap-3 md:gap-5 p-5 items-center border-b-4 border-dashed"
        style={{ borderColor: `${accent}55` }}
      >
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center font-[family-name:var(--font-display)] text-2xl text-[#0D0D1A]"
          style={{ background: accent }}
        >
          #{index + 1}
        </div>
        <div className="min-w-0">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-xs text-white/55">
            {lineup.picks.length}-pick · {lineup.playType === "power" ? "Power (all hit)" : "Flex (partial OK)"}
          </div>
          <div className="text-white text-sm mt-0.5">
            {lineup.payoutMultiplier.toFixed(2)}× payout · pays{" "}
            <span className="text-[#00F5D4] font-bold">${lineup.grossPayout.toFixed(0)}</span> if it lands
          </div>
        </div>

        <Stat label="Hit %" accent={pctColor}>
          <AnimatedPercent value={lineup.hitProbability} decimals={1} className="font-[family-name:var(--font-display)] text-3xl md:text-4xl leading-none" />
        </Stat>
        <Stat label="Avg $" accent={evColor}>
          <span style={{ color: evColor }} className="font-[family-name:var(--font-display)] text-3xl md:text-4xl leading-none">
            {lineup.expectedValue >= 0 ? "+" : ""}${lineup.expectedValue.toFixed(2)}
          </span>
        </Stat>
        <Stat label="Pays" accent="#FFE600">
          <span className="font-[family-name:var(--font-display)] text-3xl md:text-4xl text-white leading-none">
            ${lineup.grossPayout.toFixed(0)}
          </span>
        </Stat>
      </div>

      {/* Picks */}
      <ul className="grid gap-2 p-5">
        {lineup.picks.map((p, i) => {
          const isMore = p.side === "more";
          const sideColor = isMore ? "#4ADE80" : "#F87171";
          const SideIcon = isMore ? TrendingUp : TrendingDown;
          return (
            <li
              key={p.prop.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-white/10 bg-[#2D1B4E]/40 px-3 py-2.5"
            >
              <span
                className="w-7 h-7 rounded-full border-2 flex items-center justify-center font-[family-name:var(--font-display)] text-xs text-white/85"
                style={{ borderColor: sideColor }}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tight text-white text-sm md:text-base truncate">
                  {p.prop.playerName}
                </div>
                <div className="text-white/55 text-[11px] uppercase tracking-widest font-bold flex items-center gap-1.5 flex-wrap">
                  <span>{p.prop.statType}</span>
                  <span>·</span>
                  <span className="text-white/75">{isMore ? "More" : "Less"} {p.prop.line}</span>
                  <span>·</span>
                  <span>{p.prop.sport}</span>
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

      <div className="px-5 pb-5 text-white/45 text-[10px] uppercase tracking-widest font-bold">
        Entry ${entry} · {lineup.correlationRisk === "low" ? "picks independent" : lineup.correlationRisk === "medium" ? "some overlap" : "lots of overlap"}
      </div>
    </motion.article>
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
