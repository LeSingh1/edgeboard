"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { TrendingUp, TrendingDown, Sparkles, User2, Activity, Flame } from "lucide-react";
import type { Prop } from "@/lib/types";
import { useSelectionStore } from "@/stores/selectionStore";
import { useProjectionStore } from "@/stores/projectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { OddsBadge } from "@/components/OddsBadge";
import { ProjectionBadge } from "@/components/ProjectionBadge";
import { VariantTabs } from "@/components/VariantTabs";
import { variantCount, findVariantById, primaryVariant, type VariantSet } from "@/lib/variantGroups";
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
  /** All variants in this family (goblin/standard/demon). When >1, the card shows a swap picker. */
  variants?: VariantSet;
  /** Live-stat lookup function — needs the family-level resolver so swapping variants still finds the right boxscore row. */
  liveStatFor?: (prop: Prop) => PropBoxLiveStat | null;
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
export function PropBox({ prop, index, liveStat, variants, liveStatFor }: PropBoxProps) {
  const sideForFamily = useSelectionStore((s) => s.sideForFamily);
  const toggle = useSelectionStore((s) => s.toggle);
  const swapVariant = useSelectionStore((s) => s.swapVariant);

  // ── Active variant state ────────────────────────────────────────────
  // Track the active ladder rung by its propId — that's the only stable
  // identifier across goblin/std/demon ladders (oddsType alone is ambiguous
  // when there are 3 goblins and 5 demons in the family).
  const familySelection = sideForFamily(prop);
  const initialActivePropId = (() => {
    // If the family already has a bench selection, mirror that rung
    if (familySelection && variants) {
      const match = findVariantById(variants, familySelection.activePropId);
      if (match) return match.id;
    }
    // Otherwise default to the prop the live-board passed us
    return prop.id;
  })();
  const [activePropId, setActivePropId] = useState<string>(initialActivePropId);

  // Sync if upstream selection changes (e.g. another card swap, or PrizePicks
  // refresh changed propIds). Deferred via microtask to avoid render cascades.
  useEffect(() => {
    if (!familySelection || !variants) return;
    if (familySelection.activePropId !== activePropId) {
      const target = familySelection.activePropId;
      queueMicrotask(() => setActivePropId(target));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familySelection?.activePropId]);

  const activeProp: Prop =
    (variants && findVariantById(variants, activePropId)) ||
    (variants && primaryVariant(variants)) ||
    prop;
  const selected = familySelection?.activePropId === activeProp.id ? familySelection.side : null;
  const hasMultipleVariants = variantCount(variants ?? {}) > 1;

  // ── Real projection auto-fetch ──────────────────────────────────────
  // Trigger the real-projection pipeline (ESPN gamelog → mean/sigma → pMore)
  // for whatever variant the user is currently looking at. The store has a
  // concurrency queue (max 3 in-flight), so mounting 30 cards on the live
  // board just drains over ~5 seconds instead of firing 30 parallel calls.
  const ballDontLieKey = useSettingsStore((s) => s.ballDontLieKey);
  const fetchProjection = useProjectionStore((s) => s.fetchOne);
  const projection = useProjectionStore((s) => s.byProp[activeProp.id]);
  useEffect(() => {
    fetchProjection(activeProp, ballDontLieKey);
  }, [activeProp.id, ballDontLieKey, fetchProjection]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the real projection landed, prefer it. Otherwise show PrizePicks-default.
  const real = projection && projection.available ? projection : null;
  const effectivePMore = real ? real.pMore : activeProp.pMore;
  const effectivePLess = real ? real.pLess : activeProp.pLess;

  // If the active variant changed, re-resolve live stats for the new prop
  const resolvedLiveStat = liveStatFor ? liveStatFor(activeProp) : liveStat ?? null;

  const accent = accentHexFor(index);
  const accent2 = accentHexFor(index + 2);
  const accent3 = accentHexFor(index + 3);

  const borderStyle =
    index % 4 === 0 ? "solid" : index % 4 === 1 ? "dashed" : index % 4 === 2 ? "solid" : "dotted";
  const rotate = (index % 5) - 2;

  // Show percentages ONLY when we have a real projection from the ESPN model.
  // When we don't, the PrizePicks-implied values (50/40/59%) are just
  // reverse-engineered guesses — showing them as if they're computed edge
  // is misleading. The odds type badge already tells the user the line
  // difficulty; no need to slap a fake "50%" on it.
  const hasRealProb = !!real;
  const moreP = hasRealProb ? effectivePMore * 100 : null;
  const lessP = hasRealProb ? effectivePLess * 100 : null;

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

  // Live-stat rendering metadata (uses the active variant's line so swapping recolors the strip)
  const hasLive = !!resolvedLiveStat;
  // Above the line → MORE side is in the money. Color the strip accordingly so
  // the user can scan the board and immediately see which picks are hitting.
  const liveHitMore = hasLive && resolvedLiveStat!.value >= activeProp.line;
  const liveColor = !hasLive
    ? null
    : resolvedLiveStat!.isFinal
      ? liveHitMore
        ? "#4ADE80" // green — finished above line
        : "#F87171" // red — finished below
      : liveHitMore
        ? "#4ADE80" // currently above line (MORE side already locked if it stays)
        : "#FFB84D"; // currently below — pace-watch

  // Variant swap handler — preserves selection across the swap
  const onSwapVariant = (newProp: Prop) => {
    if (newProp.id === activeProp.id) return;
    // Transfer any existing bench selection to the new variant
    if (familySelection?.activePropId === activeProp.id) {
      swapVariant(activeProp.id, newProp, variants);
    }
    setActivePropId(newProp.id);
  };

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
          <div className="flex items-center gap-2 flex-wrap">
            {/* League logo — render the PrizePicks SVG as a real image so the
                multi-color logo (NBA's blue + red + white, MLB's red + blue,
                etc.) shows up authentically. A CSS mask would collapse the
                detail down to a single accent color silhouette. */}
            {prop.leagueIcon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={prop.leagueIcon}
                alt={prop.sport}
                title={prop.sport}
                className="w-6 h-6 object-contain shrink-0"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  // Fall back to text pill if the asset 404s
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                  const sib = e.currentTarget.nextElementSibling as HTMLElement | null;
                  sib?.style.removeProperty("display");
                }}
              />
            ) : null}
            {/* Fallback text pill — shown if image fails OR no leagueIcon */}
            <span
              className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border-2 font-[family-name:var(--font-heading)]"
              style={{
                borderColor: accent2,
                color: accent2,
                display: prop.leagueIcon ? "none" : undefined,
              }}
            >
              {prop.sport}
            </span>
            {/* Goblin/Demon glyph — icon-only, matches PrizePicks card header */}
            <OddsBadge oddsType={activeProp.oddsType} iconOnly />
            {/* Data-source pill — green dot "Real" when ESPN game log resolved,
                gray "Default" when we couldn't fetch and we're showing the
                PrizePicks-default 50/40/59%. */}
            <ProjectionBadge propId={activeProp.id} />
            {prop.isCombo && (
              <span
                className="rounded-full px-1.5 py-0 text-[8px] font-black uppercase border-2 tracking-widest"
                style={{ borderColor: accent3, color: accent3 }}
                title="Combo prop — two players in one projection"
              >
                Duo
              </span>
            )}
            {activeProp.trendingCount && activeProp.trendingCount >= 50 && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[8px] font-black uppercase border-2 tracking-widest border-[#FF6B35] text-[#FF6B35]"
                title={`${activeProp.trendingCount} users picked this on PrizePicks`}
              >
                <Flame size={8} strokeWidth={3} aria-hidden />
                {activeProp.trendingCount}
              </span>
            )}
          </div>
          {hasLive && resolvedLiveStat && !resolvedLiveStat.isFinal ? (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#F87171] text-[#0D0D1A] font-[family-name:var(--font-heading)] font-black uppercase text-[9px] tracking-widest whitespace-nowrap"
              title={`Game in progress — ${resolvedLiveStat.periodLabel}`}
            >
              <motion.span
                className="w-1.5 h-1.5 rounded-full bg-[#0D0D1A]"
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.2, repeat: Infinity }}
                aria-hidden
              />
              Live · {resolvedLiveStat.periodLabel}
            </span>
          ) : hasLive && resolvedLiveStat && resolvedLiveStat.isFinal ? (
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

        {/* ── Line + stat ── (line value flips when user swaps variants) */}
        <div className="relative px-4 pt-3 pb-1 mt-auto">
          <div
            className="border-t-2 border-dashed mb-2"
            style={{ borderColor: `${accent}50` }}
          />
          <div className="flex items-baseline justify-center gap-2">
            <motion.div
              key={activeProp.id}
              initial={{ scale: 0.8, opacity: 0.5 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", damping: 18 }}
              className="font-[family-name:var(--font-display)] leading-none"
              style={{ color: accent3, fontSize: "2.5rem" }}
            >
              {activeProp.line}
            </motion.div>
            <div className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-white">
              {activeProp.statType}
            </div>
          </div>
          {/* Ladder picker — shows every goblin/standard/demon line in the
              family so the user can pick any rung. PrizePicks ships ladders
              with 1–5 goblins and 1–5 demons; collapsing to one of each
              would hide ~80% of the variants for hockey shots, baseball
              pitches, etc. */}
          {hasMultipleVariants && variants && (
            <div className="flex justify-center mt-1.5">
              <VariantTabs
                variants={variants}
                activePropId={activeProp.id}
                onChange={onSwapVariant}
              />
            </div>
          )}
        </div>

        {/* ── Live in-game stat strip ── only shows when the player's game is in progress */}
        {hasLive && resolvedLiveStat && (
          <div
            className="relative mx-3 mb-2 px-3 py-1.5 rounded-xl border-2 flex items-center justify-between gap-2"
            style={{
              borderColor: liveColor!,
              backgroundColor: `${liveColor}1a`, // ~10% alpha
            }}
            title={
              resolvedLiveStat.isFinal
                ? `Final · ${resolvedLiveStat.value} ${activeProp.statType}`
                : `Live · ${resolvedLiveStat.value} ${activeProp.statType} through ${resolvedLiveStat.periodLabel}`
            }
          >
            <span
              className="flex items-center gap-1.5 font-[family-name:var(--font-heading)] font-black uppercase text-[9px] tracking-widest"
              style={{ color: liveColor! }}
            >
              <Activity size={10} strokeWidth={3} aria-hidden />
              {resolvedLiveStat.isFinal ? "Final" : "Now"}
            </span>
            <span className="flex items-baseline gap-1">
              <span
                className="font-[family-name:var(--font-display)] text-lg leading-none"
                style={{ color: liveColor! }}
              >
                {resolvedLiveStat.value}
              </span>
              <span className="text-white/40 text-[10px] font-bold">
                / {activeProp.line}
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
            {resolvedLiveStat.homeScore !== undefined && resolvedLiveStat.awayScore !== undefined ? (
              <span className="text-white/50 text-[9px] font-bold whitespace-nowrap">
                {resolvedLiveStat.homeAway === "home"
                  ? `${resolvedLiveStat.homeScore}–${resolvedLiveStat.awayScore}`
                  : `${resolvedLiveStat.awayScore}–${resolvedLiveStat.homeScore}`}
              </span>
            ) : null}
          </div>
        )}

        {/* ── MORE / LESS buttons ──
            PrizePicks rule: demon and goblin lines are MORE-only — the player
            took on a harder/easier line, you can't bet against it. Only the
            standard line offers both sides. */}
        {activeProp.oddsType !== "standard" ? (
          <div className="relative px-3 pb-3 pt-1">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={(e) => {
                e.stopPropagation();
                toggle(activeProp, "more", variants);
              }}
              aria-label={`Pick MORE on ${activeProp.playerName} ${activeProp.statType} ${activeProp.line}, ${activeProp.oddsType}${moreP ? `, ${moreP.toFixed(0)} percent chance` : ""}`}
              aria-pressed={selected === "more"}
              title={`${activeProp.oddsType === "demon" ? "Demon" : "Goblin"} — MORE only`}
              className={cn(
                "relative w-full rounded-2xl border-4 py-3 px-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider transition-all",
                "flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-[#FFE600] focus:ring-offset-2 focus:ring-offset-[#0D0D1A]",
                selected === "more"
                  ? "bg-[#4ADE80] border-[#FFE600] text-[#0D0D1A] shadow-[3px_3px_0_#0D0D1A]"
                  : "border-[#4ADE80] text-[#4ADE80] hover:bg-[#4ADE80]/15",
              )}
            >
              <TrendingUp size={16} strokeWidth={3} aria-hidden />
              <span className="text-base">More</span>
              {moreP !== null && (
                <span className="text-[10px] opacity-80 font-bold">{moreP.toFixed(0)}%</span>
              )}
            </motion.button>
            <p className="text-[9px] text-white/50 font-bold uppercase tracking-widest text-center mt-1.5">
              {activeProp.oddsType === "demon" ? "Demon" : "Goblin"} · More only
            </p>
          </div>
        ) : (
          <div className="relative px-3 pb-3 pt-1 grid grid-cols-2 gap-2">
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={(e) => {
                e.stopPropagation();
                toggle(activeProp, "more", variants);
              }}
              aria-label={`Pick MORE on ${activeProp.playerName} ${activeProp.statType} ${activeProp.line}${moreP ? `, ${moreP.toFixed(0)} percent chance` : ""}`}
              aria-pressed={selected === "more"}
              title={
                real
                  ? `Model: ${real.projection} avg from ${real.sampleSize} games`
                  : "No projection model data yet"
              }
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
              {moreP !== null && (
                <span className="text-[9px] opacity-80 font-bold">{moreP.toFixed(0)}%</span>
              )}
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={(e) => {
                e.stopPropagation();
                toggle(activeProp, "less", variants);
              }}
              aria-label={`Pick LESS on ${activeProp.playerName} ${activeProp.statType} ${activeProp.line}${lessP ? `, ${lessP.toFixed(0)} percent chance` : ""}`}
              aria-pressed={selected === "less"}
              title={
                real
                  ? `Model: ${real.projection} avg from ${real.sampleSize} games`
                  : "No projection model data yet"
              }
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
              {lessP !== null && (
                <span className="text-[9px] opacity-80 font-bold">{lessP.toFixed(0)}%</span>
              )}
            </motion.button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
