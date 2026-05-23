"use client";

import { motion } from "framer-motion";
import { useEffect, useState, useMemo } from "react";
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
  Zap,
  Layers,
  Lightbulb,
} from "lucide-react";
import { useLineupStore, type SlipStatus } from "@/stores/lineupStore";
import { useBankrollStore } from "@/stores/bankrollStore";
import { OddsBadge } from "@/components/OddsBadge";
import { PortfolioStrategy } from "@/components/PortfolioStrategy";
import { analyzeVariantStrategy } from "@/lib/variantStrategy";
import { detectReversion } from "@/lib/optimizer";
import { accentHexFor, cn } from "@/lib/cn";
import type { Lineup, PlayType, Prop, RiskMode } from "@/lib/types";

const MODE_LABEL: Record<RiskMode, string> = {
  safe: "Highest chance to hit",
  balanced: "Best avg $ (same-game penalized)",
  aggressive: "Highest avg $ per play",
};

const RISK_COLORS: Record<Lineup["correlationRisk"], { bg: string; text: string; label: string }> = {
  low:    { bg: "rgba(74,222,128,0.15)",  text: "#4ADE80", label: "Picks independent" },
  medium: { bg: "rgba(255,230,0,0.15)",   text: "#FFE600", label: "Some overlap" },
  high:   { bg: "rgba(248,113,113,0.15)", text: "#F87171", label: "Lots of overlap" },
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

  // Compute Power vs Flex mix across the leaderboard. Used in the subheading
  // so the user can see at a glance how much variety the optimizer surfaced.
  const playTypeMix = useMemo(() => {
    let p = 0;
    let f = 0;
    for (const l of lineups) {
      if (l.playType === "power") p++;
      else f++;
    }
    return { power: p, flex: f };
  }, [lineups]);

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
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
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
          {params?.lineupSize}-pick · ${params?.entryCost} entry
        </p>
        <p className="text-white/50 text-sm mt-1 uppercase tracking-widest font-bold flex items-center gap-3 flex-wrap">
          <span>
            {params?.riskMode === "safe"
              ? "Ranked by chance of hitting"
              : params?.riskMode === "aggressive"
                ? "Ranked by avg $ per play"
                : "Ranked by avg $ (same-game picks penalized)"}
          </span>
          <span className="opacity-50">·</span>
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[#7B2FFF]">
              <Zap size={12} strokeWidth={3} /> {playTypeMix.power} Power
            </span>
            <span className="inline-flex items-center gap-1 text-[#00F5D4]">
              <Layers size={12} strokeWidth={3} /> {playTypeMix.flex} Flex
            </span>
          </span>
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
      className="rounded-3xl border-8 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 via-[#7B2FFF]/30 to-[#00F5D4]/30 backdrop-blur-sm"
    >
      <div className="p-6 md:p-10">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Trophy className="text-[#FFE600]" size={28} strokeWidth={3} />
              <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#FFE600] text-sm">
                Rank #{lineup.rank} · {MODE_LABEL[mode]}
              </span>
              <PlayTypeBadge playType={lineup.playType} />
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
              Chance to hit
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Stat
              label="Avg $ / play"
              value={`${lineup.expectedValue >= 0 ? "+" : ""}$${lineup.expectedValue.toFixed(2)}`}
              accent={lineup.expectedValue >= 0 ? "#4ADE80" : "#F87171"}
            />
            <Stat label="Payout" value={`${lineup.payoutMultiplier}×`} accent="#FFE600" />
            <Stat label="If hit" value={`$${lineup.grossPayout.toFixed(0)}`} accent="#00F5D4" />
            <CorrelationBadge risk={lineup.correlationRisk} />
          </div>
        </div>

        {/* Reversion warning — same logic as the optimizer bench. When PrizePicks
            tags a slip as a reversion lineup (all picks from one game), they pay
            ~5-10% less than our estimate. Surface this above the picks so the user
            doesn't paste their slip into PrizePicks expecting the full multiplier. */}
        <ReversionBanner picks={lineup.picks.map((p) => p.prop)} grossPayout={lineup.grossPayout} />

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
                  title="Chance this side hits — uses the player's recent games when we have them, falls back to PrizePicks's default chance for this odds-type otherwise"
                >
                  <span className="text-white/40">chance </span>
                  <span style={{ color: accent }}>{(p.probability * 100).toFixed(0)}%</span>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Variant strategy callout — explains WHY a goblin/demon was chosen */}
        <VariantStrategyCallout lineup={lineup} />

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
      <div className="flex items-center justify-between mb-3 gap-2">
        <div
          className="font-[family-name:var(--font-display)] text-4xl leading-none"
          style={{ color: accent }}
        >
          #{lineup.rank}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <PlayTypeBadge playType={lineup.playType} compact />
          <CorrelationBadge risk={lineup.correlationRisk} compact />
        </div>
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
        <span className="text-xs text-white/50 font-bold uppercase tracking-wider">Chance</span>
      </div>
      <div className="text-white/60 text-xs mb-4 font-bold uppercase tracking-wider" title="Average dollars per play long-term · max possible payout if all picks land">
        Avg {lineup.expectedValue >= 0 ? "+" : ""}${lineup.expectedValue.toFixed(2)}/play · ${lineup.grossPayout.toFixed(0)} if hit
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

      {/* Compact one-line variant strategy hint */}
      <VariantStrategyCallout lineup={lineup} compact />
    </motion.div>
  );
}

/**
 * One-line (compact) or full-block callout explaining the lineup's variant mix —
 * "Goblin Allen — easier line, safer floor · Use 1.5 instead of 2.5"
 * Returns null when every pick is standard (nothing to call out).
 */
function VariantStrategyCallout({
  lineup,
  compact = false,
}: {
  lineup: Lineup;
  compact?: boolean;
}) {
  const strategy = analyzeVariantStrategy(lineup);
  if (!strategy) return null;

  if (compact) {
    return (
      <div
        className="mt-3 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#00F5D4]"
        title={strategy.detail}
      >
        <Lightbulb size={11} strokeWidth={3} aria-hidden />
        <span className="truncate">{strategy.summary}</span>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6 rounded-2xl border-4 border-dashed border-[#00F5D4] bg-[#00F5D4]/10 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl border-4 border-[#00F5D4] flex items-center justify-center flex-shrink-0">
          <Lightbulb size={18} strokeWidth={3} className="text-[#00F5D4]" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#00F5D4] text-[10px]">
            Variant strategy
          </div>
          <div className="font-[family-name:var(--font-heading)] font-black text-white text-base mt-1">
            {strategy.summary}
          </div>
          <div className="text-white/70 text-xs mt-1.5 leading-relaxed">{strategy.detail}</div>
          <div className="flex items-center gap-3 mt-3 text-[10px] font-bold uppercase tracking-widest">
            {strategy.goblinCount > 0 && (
              <span className="text-[#4ADE80]">
                ● {strategy.goblinCount} goblin
              </span>
            )}
            {strategy.standardCount > 0 && (
              <span className="text-[#FFE600]">
                ● {strategy.standardCount} standard
              </span>
            )}
            {strategy.demonCount > 0 && (
              <span className="text-[#FF6B35]">
                ● {strategy.demonCount} demon
              </span>
            )}
          </div>
        </div>
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

function PlayTypeBadge({ playType, compact = false }: { playType: PlayType; compact?: boolean }) {
  const isPower = playType === "power";
  return (
    <span
      title={
        isPower
          ? "Power — every pick must hit. No partial payouts."
          : "Flex — partial hits still pay (e.g. 3/4 wins)."
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-widest",
        compact ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs",
      )}
      style={{
        borderColor: isPower ? "#7B2FFF" : "#00F5D4",
        color: isPower ? "#7B2FFF" : "#00F5D4",
        background: isPower ? "rgba(123,47,255,0.12)" : "rgba(0,245,212,0.12)",
      }}
    >
      {isPower ? <Zap size={compact ? 10 : 12} strokeWidth={3} aria-hidden /> : <Layers size={compact ? 10 : 12} strokeWidth={3} aria-hidden />}
      {isPower ? "Power" : "Flex"}
    </span>
  );
}

/**
 * Reversion lineup warning — when all (or most) picks come from the same game,
 * PrizePicks applies a reduced payout multiplier. We can't know the exact
 * discount they use (not in their public API), but it's empirically ~5–10%
 * lower than the standard multiplier. This banner tells the user to expect
 * less than the headline payout when they enter the slip on PrizePicks.
 */
function ReversionBanner({ picks, grossPayout }: { picks: Prop[]; grossPayout: number }) {
  const r = detectReversion(picks);
  if (r.level === "none") return null;
  const isFull = r.level === "full";
  // Show a likely-actual range — PrizePicks's reversion discount is 5–10%
  const minPayout = grossPayout * 0.90;
  const maxPayout = grossPayout * 0.95;
  return (
    <div
      className={cn(
        "mb-5 rounded-2xl border-4 border-dashed p-4 flex items-start gap-3",
        isFull ? "border-[#FF6B35] bg-[#FF6B35]/10" : "border-[#FFE600] bg-[#FFE600]/10",
      )}
      role="status"
      title={
        isFull
          ? "All your picks are in the same game. PrizePicks tags this a 'reversion lineup' and pays roughly 5–10% less than the standard multiplier."
          : `${r.sharedCount} of ${r.totalPicks} picks share a game. PrizePicks may apply a partial reversion discount.`
      }
    >
      <span className="text-2xl flex-shrink-0" aria-hidden>⚠</span>
      <div className="flex-1 min-w-0">
        <div
          className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-xs"
          style={{ color: isFull ? "#FF6B35" : "#FFE600" }}
        >
          {isFull ? "Reversion lineup detected" : "Partial reversion"}
        </div>
        <p className="text-white/80 text-sm mt-1 leading-snug">
          {isFull ? (
            <>
              All <strong>{r.totalPicks}</strong> picks share one game. PrizePicks pays{" "}
              <strong className="text-[#FF6B35]">~5–10% less</strong> on reversion slips —{" "}
              expect somewhere between{" "}
              <strong className="text-white">${minPayout.toFixed(0)}–${maxPayout.toFixed(0)}</strong>{" "}
              instead of the ${grossPayout.toFixed(0)} above.
            </>
          ) : (
            <>
              <strong>{r.sharedCount}</strong> of {r.totalPicks} picks share a game. PrizePicks
              may pay slightly less than the ${grossPayout.toFixed(0)} shown.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function CorrelationBadge({ risk, compact = false }: { risk: Lineup["correlationRisk"]; compact?: boolean }) {
  const c = RISK_COLORS[risk];
  const tooltip =
    risk === "low"
      ? "Picks are from different games and players — outcomes are independent."
      : risk === "medium"
        ? "Some picks share a game or player — outcomes are partially linked."
        : "Many picks share games or players. Results will be lumpy — big wins or big zeros, not balanced.";
  return (
    <span
      title={tooltip}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider whitespace-nowrap",
        compact ? "px-2 py-0.5 text-[10px]" : "px-3 py-1.5 text-xs",
      )}
      style={{ borderColor: c.text, color: c.text, background: c.bg }}
    >
      {/* Color-not-only: dot reinforces severity at a glance for users who
          can't distinguish red/yellow/green easily. */}
      <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: c.text }} />
      {c.label}
    </span>
  );
}
