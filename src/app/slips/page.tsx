"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  Trophy,
  CircleCheck,
  CircleX,
  CircleDashed,
} from "lucide-react";
import { useLineupStore, type SlipStatus } from "@/stores/lineupStore";
import { useBankrollStore } from "@/stores/bankrollStore";
import { OddsBadge } from "@/components/OddsBadge";
import { PortfolioStrategy } from "@/components/PortfolioStrategy";
import { accentHexFor, cn } from "@/lib/cn";
import type { Lineup, RiskMode } from "@/lib/types";

const MODE_LABEL: Record<RiskMode, string> = {
  safe: "Highest hit %",
  balanced: "Best EV (corr-weighted)",
  aggressive: "Highest raw EV",
};

const RISK_COLORS: Record<Lineup["correlationRisk"], { bg: string; text: string; label: string }> = {
  low:    { bg: "rgba(74,222,128,0.15)",  text: "#4ADE80", label: "Low corr." },
  medium: { bg: "rgba(255,230,0,0.15)",   text: "#FFE600", label: "Med corr." },
  high:   { bg: "rgba(248,113,113,0.15)", text: "#F87171", label: "High corr." },
};

export default function SlipsPage() {
  const router = useRouter();
  const { lineups, totalGenerated, elapsedMs, params } = useLineupStore();

  // If the user opens /slips directly with no generated lineups (e.g. browser
  // restored the URL from a previous session), bounce them to the live board
  // — the slips view is meaningless without a fresh optimizer run.
  useEffect(() => {
    if (!lineups.length) {
      router.replace("/live-board");
    }
  }, [lineups.length, router]);

  if (!lineups.length) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-center relative">
        <Trophy size={64} className="mx-auto text-[#FFE600] animate-(--animate-wiggle)" />
        <p className="text-white/60 mt-6 uppercase tracking-widest font-bold text-xs">
          No slips generated — taking you to the live board...
        </p>
      </div>
    );
  }

  const best = lineups[0];

  return (
    <div className="relative max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <div
        aria-hidden
        className="absolute -top-10 right-0 font-[family-name:var(--font-display)] text-[14rem] md:text-[20rem] leading-none pointer-events-none select-none opacity-[0.06] text-[#FFE600]"
      >
        WIN
      </div>

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-10 relative"
      >
        <h1 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow">
          Leaderboard
        </h1>
        <p className="text-white/70 text-lg mt-3">
          {totalGenerated.toLocaleString()} lineups crunched in {elapsedMs}ms ·{" "}
          {params?.lineupSize}-pick {params?.playType} · ${params?.entryCost} entry
        </p>
        <p className="text-white/50 text-sm mt-1 uppercase tracking-widest font-bold">
          {params?.riskMode === "safe"
            ? "Ranked by hit probability"
            : params?.riskMode === "aggressive"
              ? "Ranked by raw EV"
              : "Ranked by EV (correlation-weighted)"}
        </p>
      </motion.div>

      {/* Hero best slip */}
      <BestSlipHero lineup={best} mode={params?.riskMode ?? "balanced"} />

      {/* Portfolio strategy — how many of these N lineups to actually enter */}
      <PortfolioStrategy lineups={lineups} />

      {/* Other slips */}
      {lineups.length > 1 ? (
        <>
          <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-3xl mt-16 mb-6 text-shadow-1">
            {lineups.length - 1 === 1
              ? "1 other alternative"
              : `Next ${lineups.length - 1} alternative${lineups.length - 1 === 1 ? "" : "s"}`}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {lineups.slice(1).map((l, i) => (
              <LineupCard key={l.id} lineup={l} index={i + 1} />
            ))}
          </div>
        </>
      ) : (
        <div className="mt-12 rounded-2xl border-4 border-dashed border-white/20 p-6 text-center text-white/60 text-sm">
          That&apos;s the only valid lineup with these {best.picks.length} picks at this size. Add more
          props or change the lineup size to see alternatives.
        </div>
      )}
    </div>
  );
}

function BestSlipHero({ lineup, mode }: { lineup: Lineup; mode: RiskMode }) {
  const [copied, setCopied] = useState(false);
  const status = useLineupStore((s) => s.statuses[lineup.id]) ?? "draft";
  const setStatus = useLineupStore((s) => s.setStatus);
  const recordEntry = useBankrollStore((s) => s.recordEntry);
  const resolve = useBankrollStore((s) => s.resolve);

  const copy = () => {
    const text = lineup.picks
      .map((p) => `${p.prop.playerName} ${p.prop.statType} ${p.side.toUpperCase()} ${p.prop.line}`)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const markEntered = () => {
    setStatus(lineup.id, "entered");
    recordEntry({
      id: lineup.id,
      entry: lineup.entryCost,
      payout: lineup.grossPayout,
      hitProb: lineup.hitProbability,
    });
  };

  const markResult = (result: "won" | "lost" | "partial") => {
    const realized =
      result === "won" ? lineup.grossPayout : result === "partial" ? lineup.grossPayout * 0.4 : 0;
    setStatus(lineup.id, result);
    resolve(lineup.id, result, realized);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", damping: 22 }}
      className="relative rounded-3xl border-8 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 via-[#7B2FFF]/30 to-[#00F5D4]/30 backdrop-blur-sm overflow-hidden"
      style={{ boxShadow: "10px 10px 0 #FF3AF2, 20px 20px 0 #00F5D4" }}
    >
      {/* Pattern overlay */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: "radial-gradient(circle, #FFE600 1px, transparent 1px)",
          backgroundSize: "30px 30px",
        }}
      />

      <div className="relative p-6 md:p-10">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Trophy className="text-[#FFE600]" size={28} strokeWidth={3} />
              <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#FFE600] text-sm">
                Rank #{lineup.rank} · {MODE_LABEL[mode]}
              </span>
            </div>
            <h2
              className="font-[family-name:var(--font-display)] text-6xl md:text-8xl leading-none text-shadow-3"
              style={{
                color:
                  lineup.hitProbability >= 0.25
                    ? "#4ADE80"
                    : lineup.hitProbability >= 0.10
                      ? "#FFE600"
                      : "#F87171",
              }}
            >
              {(lineup.hitProbability * 100).toFixed(1)}%
            </h2>
            <p className="text-white/70 text-base mt-2 uppercase tracking-wider font-bold">
              Hit probability
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Stat
              label="EV"
              value={`${lineup.expectedValue >= 0 ? "+" : ""}$${lineup.expectedValue.toFixed(2)}`}
              accent={lineup.expectedValue >= 0 ? "#4ADE80" : "#F87171"}
            />
            <Stat label="Payout" value={`${lineup.payoutMultiplier}×`} accent="#FFE600" />
            <Stat label="If hit" value={`$${lineup.grossPayout.toFixed(0)}`} accent="#00F5D4" />
            <CorrelationBadge risk={lineup.correlationRisk} />
          </div>
        </div>

        {/* Picks */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {lineup.picks.map((p, i) => {
            const isMore = p.side === "more";
            const accent = accentHexFor(i);
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.05 }}
                className="relative rounded-2xl border-4 p-4 bg-[#0D0D1A]/60 backdrop-blur-sm"
                style={{ borderColor: accent, boxShadow: `3px 3px 0 ${accent}` }}
              >
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <div
                    className={cn(
                      "w-8 h-8 rounded-lg border-2 flex items-center justify-center",
                      isMore ? "border-[#4ADE80] text-[#4ADE80]" : "border-[#F87171] text-[#F87171]",
                    )}
                  >
                    {isMore ? <TrendingUp size={14} strokeWidth={3} /> : <TrendingDown size={14} strokeWidth={3} />}
                  </div>
                  <span className="text-xs uppercase tracking-widest font-bold" style={{ color: accent }}>
                    {p.prop.sport}
                  </span>
                  <OddsBadge oddsType={p.prop.oddsType} compact />
                </div>
                <div className="font-[family-name:var(--font-heading)] font-black text-sm uppercase truncate">
                  {p.prop.playerName}
                </div>
                <div className="text-white/60 text-xs mt-1">
                  {p.prop.statType} {isMore ? ">" : "<"} {p.prop.line}
                </div>
                <div
                  className="text-[10px] mt-1 font-bold"
                  title="PrizePicks-implied probability for this side based on odds_type"
                >
                  <span className="text-white/40">implied </span>
                  <span style={{ color: accent }}>{(p.probability * 100).toFixed(0)}%</span>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-3 items-center">
          <button
            onClick={copy}
            className="relative flex items-center gap-2 px-6 h-14 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white hover:scale-105 active:scale-95 transition-transform focus:outline-none focus:ring-4 focus:ring-[#FFE600]/60"
          >
            {copied ? <Check size={18} strokeWidth={3} /> : <Copy size={18} strokeWidth={3} />}
            {copied ? "Copied!" : "Copy picks"}
          </button>

          {status === "draft" && (
            <button
              onClick={markEntered}
              className="relative flex items-center gap-2 px-6 h-14 rounded-full border-4 border-dashed border-[#FFE600] text-[#FFE600] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest hover:bg-[#FFE600]/10 transition-colors focus:outline-none focus:ring-4 focus:ring-[#FFE600]/40"
              title="Record this slip as entered on PrizePicks — adds to bankroll tracking in Settings"
            >
              <CircleDashed size={18} strokeWidth={3} />
              Mark entered
            </button>
          )}

          {status === "entered" && (
            <div className="flex gap-2 items-center">
              <StatusChip status="entered" />
              <button
                onClick={() => markResult("won")}
                className="px-4 h-12 rounded-full border-4 border-[#4ADE80] text-[#4ADE80] font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest hover:bg-[#4ADE80]/15 focus:outline-none focus:ring-2 focus:ring-[#4ADE80]"
              >
                <CircleCheck size={14} strokeWidth={3} className="inline mr-1" />
                Won
              </button>
              <button
                onClick={() => markResult("lost")}
                className="px-4 h-12 rounded-full border-4 border-[#F87171] text-[#F87171] font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest hover:bg-[#F87171]/15 focus:outline-none focus:ring-2 focus:ring-[#F87171]"
              >
                <CircleX size={14} strokeWidth={3} className="inline mr-1" />
                Lost
              </button>
              {lineup.playType === "flex" && (
                <button
                  onClick={() => markResult("partial")}
                  className="px-4 h-12 rounded-full border-4 border-[#FFE600] text-[#FFE600] font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest hover:bg-[#FFE600]/15 focus:outline-none focus:ring-2 focus:ring-[#FFE600]"
                >
                  Partial
                </button>
              )}
            </div>
          )}

          {(status === "won" || status === "lost" || status === "partial") && (
            <StatusChip status={status} />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function LineupCard({ lineup, index }: { lineup: Lineup; index: number }) {
  const accent = accentHexFor(index);
  const accent2 = accentHexFor(index + 1);
  const rotate = (index % 5) - 2;
  const borderStyle =
    index % 3 === 0 ? "solid" : index % 3 === 1 ? "dashed" : "dotted";

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, rotate: 0 }}
      animate={{ opacity: 1, y: 0, rotate: rotate * 0.5 }}
      transition={{ delay: Math.min(index * 0.04, 0.3) }}
      whileHover={{ scale: 1.03, rotate: rotate, y: -4 }}
      className="relative rounded-3xl border-4 p-5 backdrop-blur-sm bg-[#2D1B4E]/60"
      style={{
        borderColor: accent,
        borderStyle,
        boxShadow: `5px 5px 0 ${accent2}`,
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div
          className="font-[family-name:var(--font-display)] text-4xl leading-none"
          style={{ color: accent }}
        >
          #{lineup.rank}
        </div>
        <CorrelationBadge risk={lineup.correlationRisk} compact />
      </div>

      <div className="flex items-baseline gap-2 mb-1">
        <span
          className="font-[family-name:var(--font-heading)] font-black text-3xl"
          style={{
            color:
              lineup.hitProbability >= 0.25
                ? "#4ADE80"
                : lineup.hitProbability >= 0.10
                  ? "#FFE600"
                  : "#F87171",
          }}
        >
          {(lineup.hitProbability * 100).toFixed(1)}%
        </span>
        <span className="text-xs text-white/50 font-bold uppercase tracking-wider">Hit prob</span>
      </div>
      <div className="text-white/60 text-xs mb-4 font-bold uppercase tracking-wider">
        EV {lineup.expectedValue >= 0 ? "+" : ""}${lineup.expectedValue.toFixed(2)} · ${lineup.grossPayout.toFixed(0)} payout
      </div>

      <div className="space-y-1.5 text-xs">
        {lineup.picks.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className={cn(
                "w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0",
                p.side === "more" ? "border-[#4ADE80] text-[#4ADE80]" : "border-[#F87171] text-[#F87171]",
              )}
            >
              {p.side === "more" ? "+" : "−"}
            </span>
            <span className="text-white truncate font-bold">{p.prop.playerName}</span>
            <span className="text-white/40 flex-shrink-0">
              {p.prop.statType.slice(0, 4)} {p.prop.line}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      className="rounded-2xl border-4 px-4 py-2 backdrop-blur-sm bg-[#0D0D1A]/40"
      style={{ borderColor: accent }}
    >
      <div className="text-[10px] uppercase tracking-widest font-bold text-white/60">{label}</div>
      <div className="font-[family-name:var(--font-heading)] font-black text-xl" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: SlipStatus }) {
  const map: Record<SlipStatus, { color: string; label: string; Icon: typeof CircleCheck }> = {
    draft:   { color: "#737373",  label: "Draft",    Icon: CircleDashed },
    entered: { color: "#FFE600",  label: "Entered",  Icon: CircleDashed },
    won:     { color: "#4ADE80",  label: "Won",      Icon: CircleCheck },
    lost:    { color: "#F87171",  label: "Lost",     Icon: CircleX },
    partial: { color: "#FF6B35",  label: "Partial",  Icon: CircleCheck },
  };
  const m = map[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-xs"
      style={{ borderColor: m.color, color: m.color, background: `${m.color}15` }}
    >
      <m.Icon size={14} strokeWidth={3} />
      {m.label}
    </span>
  );
}

function CorrelationBadge({ risk, compact = false }: { risk: Lineup["correlationRisk"]; compact?: boolean }) {
  const c = RISK_COLORS[risk];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider",
        compact ? "px-2 py-0.5 text-[10px]" : "px-3 py-1.5 text-xs",
      )}
      style={{ borderColor: c.text, color: c.text, background: c.bg }}
    >
      {c.label}
    </span>
  );
}
