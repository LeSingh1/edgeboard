"use client";

import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Sparkles, User2, Activity } from "lucide-react";
import type { Prop } from "@/lib/types";
import { useSelectionStore } from "@/stores/selectionStore";
import { OddsBadge } from "@/components/OddsBadge";
import { accentHexFor, cn } from "@/lib/cn";

export interface PropBoxLiveStat {
  /** Current in-game value for this prop's statType (e.g. 12 for PTS in Q3) */
  value: number;
  /** "Q3 4:32" or "T5" or "FINAL" */
  periodLabel: string;
  isFinal: boolean;
  homeScore?: number;
  awayScore?: number;
  /** Which side of the box the player's team is on, for orienting the score */
  homeAway?: "home" | "away";
}

interface PropBoxProps {
  prop: Prop;
  index: number;
  /** Optional live-game stats fetched from ESPN/MLB boxscore. null if game hasn't started. */
  liveStat?: PropBoxLiveStat | null;
}

/**
 * PrizePicks-faithful prop card with Maximalism treatment.
 *
 * Top → bottom:
 *   Header chip (sport + game time, optional demon/goblin badge)
 *   Player headshot (circular)
 *   Player name + team / position
 *   Line + stat type
 *   MORE / LESS buttons with PrizePicks-implied probability
 */
export function PropBox({ prop, index, liveStat }: PropBoxProps) {
  const sideFor = useSelectionStore((s) => s.sideFor);
  const toggle = useSelectionStore((s) => s.toggle);
  const selected = sideFor(prop.id);

  const accent = accentHexFor(index);
  const accent2 = accentHexFor(index + 2);
  const accent3 = accentHexFor(index + 3);

  const borderStyle =
    index % 4 === 0 ? "solid" : index % 4 === 1 ? "dashed" : index % 4 === 2 ? "solid" : "dotted";
  const rotate = (index % 5) - 2;

  const moreP = prop.pMore * 100;
  const lessP = prop.pLess * 100;

  // Time chip — if the game isn't today, prefix the day so the user can tell
  // a 7:30 PM tomorrow apart from a 7:30 PM tonight at a glance.
  const time = (() => {
    if (!prop.gameTime) return "";
    const d = new Date(prop.gameTime);
    if (isNaN(d.getTime())) return "";
    const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const todayKey = (() => {
      const n = new Date();
      return `${n.getFullYear()}-${n.getMonth()}-${n.getDate()}`;
    })();
    const propKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (todayKey === propKey) return t;
    const dayLabel = d.toLocaleDateString("en-US", { weekday: "short" });
    return `${dayLabel} · ${t}`;
  })();

  // Live-stat rendering metadata
  const hasLive = !!liveStat;
  // Above the line → MORE side is in the money. Color the strip accordingly so
  // the user can scan the board and immediately see which picks are hitting.
  const liveHitMore = hasLive && liveStat!.value >= prop.line;
  const liveColor = !hasLive
    ? null
    : liveStat!.isFinal
      ? liveHitMore
        ? "#4ADE80" // green — finished above line
        : "#F87171" // red — finished below
      : liveHitMore
        ? "#4ADE80" // currently above line (MORE side already locked if it stays)
        : "#FFB84D"; // currently below — pace-watch

  const initials = prop.playerName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 30, rotate: 0 }}
      animate={{ opacity: 1, y: 0, rotate }}
      transition={{
        opacity: { duration: 0.3, delay: Math.min(index * 0.01, 0.3) },
        y: { duration: 0.4, type: "spring", damping: 22 },
      }}
      whileHover={{ scale: 1.03, rotate: rotate * 1.5, zIndex: 5 }}
      className="relative h-full"
      style={{ zIndex: selected ? 4 : 1 }}
    >
      <div
        aria-hidden
        className="absolute inset-0 rounded-3xl transition-all"
        style={{
          boxShadow: selected
            ? `5px 5px 0 ${accent2}, 10px 10px 0 ${accent3}, 0 0 50px ${accent}`
            : `5px 5px 0 ${accent2}, 10px 10px 0 ${accent3}`,
        }}
      />

      <div
        className={cn(
          "relative h-full rounded-3xl border-4 backdrop-blur-sm bg-[#2D1B4E]/70 overflow-hidden flex flex-col",
          selected && "ring-4 ring-offset-2 ring-offset-[#0D0D1A]",
        )}
        style={{
          borderColor: accent,
          borderStyle,
          // @ts-expect-error CSS custom property
          "--tw-ring-color": accent,
        }}
      >
        {/* Pattern overlay */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-10"
          style={{
            backgroundImage:
              index % 3 === 0
                ? `radial-gradient(circle, ${accent} 1px, transparent 1px)`
                : index % 3 === 1
                  ? `repeating-linear-gradient(45deg, transparent, transparent 8px, ${accent2} 8px, ${accent2} 16px)`
                  : "none",
            backgroundSize: "20px 20px",
          }}
        />

        {/* Selected sparkle */}
        {selected && (
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            className="absolute -top-3 -right-3 z-20 w-12 h-12 rounded-full bg-[#FFE600] border-4 border-[#0D0D1A] flex items-center justify-center"
            style={{ boxShadow: `0 0 24px ${accent}` }}
          >
            <Sparkles size={20} className="text-[#0D0D1A]" strokeWidth={3} fill="#0D0D1A" />
          </motion.div>
        )}

        {/* ── Header row ── */}
        <div className="relative px-4 pt-4 pb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border-2 font-[family-name:var(--font-heading)]"
              style={{ borderColor: accent2, color: accent2 }}
            >
              {prop.sport}
            </span>
            <OddsBadge oddsType={prop.oddsType} compact />
            {prop.isCombo && (
              <span
                className="rounded-full px-1.5 py-0 text-[8px] font-black uppercase border-2 tracking-widest"
                style={{ borderColor: accent3, color: accent3 }}
                title="Combo prop — two players in one projection"
              >
                Duo
              </span>
            )}
          </div>
          {hasLive && !liveStat!.isFinal ? (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#F87171] text-[#0D0D1A] font-[family-name:var(--font-heading)] font-black uppercase text-[9px] tracking-widest whitespace-nowrap"
              title={`Game in progress — ${liveStat!.periodLabel}`}
            >
              <motion.span
                className="w-1.5 h-1.5 rounded-full bg-[#0D0D1A]"
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.2, repeat: Infinity }}
                aria-hidden
              />
              Live · {liveStat!.periodLabel}
            </span>
          ) : hasLive && liveStat!.isFinal ? (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/20 text-white font-[family-name:var(--font-heading)] font-black uppercase text-[9px] tracking-widest whitespace-nowrap"
              title="Game finished — line settles to this value"
            >
              Final
            </span>
          ) : prop.isLive ? (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#F87171] text-[#0D0D1A] font-[family-name:var(--font-heading)] font-black uppercase text-[9px] tracking-widest"
              title="Game is currently in progress — line is locked or rapidly changing"
            >
              <motion.span
                className="w-1.5 h-1.5 rounded-full bg-[#0D0D1A]"
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.2, repeat: Infinity }}
                aria-hidden
              />
              Live
            </span>
          ) : (
            <span className="text-white/50 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap">
              {time}
            </span>
          )}
        </div>

        {/* ── Headshot ── */}
        <div className="relative flex flex-col items-center pt-2 pb-1">
          <div
            className="relative w-24 h-24 rounded-full border-4 overflow-hidden bg-[#0D0D1A] flex items-center justify-center"
            style={{
              borderColor: accent,
              boxShadow: `0 0 18px ${accent}40, 3px 3px 0 ${accent2}`,
            }}
          >
            {prop.playerImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={prop.playerImage}
                alt={prop.playerName}
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                  (e.currentTarget.nextElementSibling as HTMLElement)?.style.removeProperty("display");
                }}
              />
            ) : null}
            <div
              className="absolute inset-0 flex items-center justify-center font-[family-name:var(--font-heading)] font-black text-3xl"
              style={{
                display: prop.playerImage ? "none" : "flex",
                color: accent3,
                background: `radial-gradient(circle, ${accent}30, ${accent2}20)`,
              }}
            >
              {initials || <User2 size={36} strokeWidth={3} />}
            </div>
          </div>
        </div>

        {/* ── Name + team ── */}
        <div className="relative px-3 pt-2 text-center">
          <h3
            className={cn(
              "font-[family-name:var(--font-heading)] font-black uppercase leading-tight tracking-tight",
              prop.playerName.length > 22 ? "text-sm" : "text-base",
            )}
            style={{ textShadow: `1.5px 1.5px 0 ${accent3}, 3px 3px 0 ${accent}` }}
            title={prop.playerName}
          >
            {prop.playerName}
          </h3>
          <div className="text-white/60 text-[11px] mt-0.5 uppercase tracking-wider font-bold">
            {prop.team || prop.playerTeamName || "—"}
            {prop.opponent ? <> <span className="opacity-50">vs</span> {prop.opponent}</> : null}
            {prop.playerPosition ? <span className="opacity-50"> · {prop.playerPosition}</span> : null}
          </div>
        </div>

        {/* ── Line + stat ── */}
        <div className="relative px-4 pt-3 pb-2 mt-auto">
          <div
            className="border-t-2 border-dashed mb-2"
            style={{ borderColor: `${accent}50` }}
          />
          <div className="flex items-baseline justify-center gap-2">
            <div
              className="font-[family-name:var(--font-display)] leading-none"
              style={{ color: accent3, fontSize: "2.5rem" }}
            >
              {prop.line}
            </div>
            <div className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-white">
              {prop.statType}
            </div>
          </div>
        </div>

        {/* ── Live in-game stat strip ── only shows when the player's game is in progress */}
        {hasLive && (
          <div
            className="relative mx-3 mb-2 px-3 py-1.5 rounded-xl border-2 flex items-center justify-between gap-2"
            style={{
              borderColor: liveColor!,
              backgroundColor: `${liveColor}1a`, // ~10% alpha
            }}
            title={
              liveStat!.isFinal
                ? `Final · ${liveStat!.value} ${prop.statType}`
                : `Live · ${liveStat!.value} ${prop.statType} through ${liveStat!.periodLabel}`
            }
          >
            <span
              className="flex items-center gap-1.5 font-[family-name:var(--font-heading)] font-black uppercase text-[9px] tracking-widest"
              style={{ color: liveColor! }}
            >
              <Activity size={10} strokeWidth={3} aria-hidden />
              {liveStat!.isFinal ? "Final" : "Now"}
            </span>
            <span className="flex items-baseline gap-1">
              <span
                className="font-[family-name:var(--font-display)] text-lg leading-none"
                style={{ color: liveColor! }}
              >
                {liveStat!.value}
              </span>
              <span className="text-white/40 text-[10px] font-bold">
                / {prop.line}
              </span>
              {liveHitMore && (
                <span
                  className="ml-0.5 text-[10px] font-black"
                  style={{ color: liveColor! }}
                  aria-label="Above the line"
                >
                  ✓
                </span>
              )}
            </span>
            {liveStat!.homeScore !== undefined && liveStat!.awayScore !== undefined ? (
              <span className="text-white/50 text-[9px] font-bold whitespace-nowrap">
                {liveStat!.homeAway === "home"
                  ? `${liveStat!.homeScore}–${liveStat!.awayScore}`
                  : `${liveStat!.awayScore}–${liveStat!.homeScore}`}
              </span>
            ) : null}
          </div>
        )}

        {/* ── MORE / LESS buttons (PrizePicks-implied probabilities) ── */}
        <div className="relative px-3 pb-3 pt-1 grid grid-cols-2 gap-2">
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={(e) => {
              e.stopPropagation();
              toggle(prop, "more");
            }}
            aria-label={`Pick MORE on ${prop.playerName} ${prop.statType} ${prop.line}, implied ${moreP.toFixed(0)} percent`}
            aria-pressed={selected === "more"}
            title={`PrizePicks-implied probability based on ${prop.oddsType} odds_type`}
            className={cn(
              "relative rounded-2xl border-4 py-2.5 px-1 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider transition-all",
              "flex flex-col items-center justify-center gap-0 focus:outline-none focus:ring-2 focus:ring-[#FFE600] focus:ring-offset-2 focus:ring-offset-[#0D0D1A]",
              selected === "more"
                ? "bg-[#4ADE80] border-[#FFE600] text-[#0D0D1A] shadow-[3px_3px_0_#0D0D1A]"
                : "border-[#4ADE80] text-[#4ADE80] hover:bg-[#4ADE80]/15",
            )}
          >
            <div className="flex items-center gap-1 text-sm">
              <TrendingUp size={14} strokeWidth={3} aria-hidden />
              More
            </div>
            <span className="text-[9px] opacity-80 font-bold">{moreP.toFixed(0)}%</span>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={(e) => {
              e.stopPropagation();
              toggle(prop, "less");
            }}
            aria-label={`Pick LESS on ${prop.playerName} ${prop.statType} ${prop.line}, implied ${lessP.toFixed(0)} percent`}
            aria-pressed={selected === "less"}
            title={`PrizePicks-implied probability based on ${prop.oddsType} odds_type`}
            className={cn(
              "relative rounded-2xl border-4 py-2.5 px-1 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider transition-all",
              "flex flex-col items-center justify-center gap-0 focus:outline-none focus:ring-2 focus:ring-[#FFE600] focus:ring-offset-2 focus:ring-offset-[#0D0D1A]",
              selected === "less"
                ? "bg-[#F87171] border-[#FFE600] text-[#0D0D1A] shadow-[3px_3px_0_#0D0D1A]"
                : "border-[#F87171] text-[#F87171] hover:bg-[#F87171]/15",
            )}
          >
            <div className="flex items-center gap-1 text-sm">
              <TrendingDown size={14} strokeWidth={3} aria-hidden />
              Less
            </div>
            <span className="text-[9px] opacity-80 font-bold">{lessP.toFixed(0)}%</span>
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}
