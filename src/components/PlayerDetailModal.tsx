"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X, TrendingUp, TrendingDown, User2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Prop, PickSide } from "@/lib/types";
import { useProjectionStore } from "@/stores/projectionStore";
import { OddsBadge } from "@/components/OddsBadge";
import { cn } from "@/lib/cn";

interface PlayerDetailModalProps {
  open: boolean;
  onClose: () => void;
  /** The prop the user clicked on. Drives the headshot, name, line, stat type. */
  prop: Prop;
  /** Side currently picked on the bench, if any. Drives MORE/LESS toggle state. */
  selectedSide: PickSide | null;
  /** Tap MORE / LESS — toggles the bench selection (same behavior as the card). */
  onToggleSide: (side: PickSide) => void;
  /** Pre-computed probabilities — usually the patched values from the parent
   *  (real projection > implied fallback). When `null` we don't render the %. */
  moreP: number | null;
  lessP: number | null;
}

/**
 * Fullscreen PrizePicks-style player detail modal.
 *
 * Layout (desktop, mirrors PrizePicks):
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │  [headshot]  Dean Wade                  ┌──────────┐   │
 *   │              CLE · F-C · vs NYK         │   5.5    │   │
 *   │              Sat May 23 5:10 PM         │ Rebs+Asts│   │
 *   │              [demon]                    │ ↑ MORE   │   │
 *   │                                         └──────────┘   │
 *   │  ┌──────── bar chart ────────┐    Day  Opp  Rebs+Asts  │
 *   │  │   ▮  ▮  ▮  ▮  ▮ -- proj   │   May21 NYK     6      │
 *   │  └───────────────────────────┘   May19 NYK     8      │
 *   │  ┌── Avg Last 5: 6.00 ──┐         May17 DET     7     │
 *   │  └──────────────────────┘         May15 DET     3     │
 *   │                                    May13 DET     6     │
 *   └────────────────────────────────────────────────────────┘
 *
 * Animations (framer-motion):
 *   - Scrim fades 200ms
 *   - Sheet slides up + fades (y:40 → 0, spring)
 *   - Headshot + name + meta stagger in
 *   - Bars stagger upward with custom ease, projection line draws last
 *   - Per-game rows fade in one by one
 *   - Exit ~70% of enter duration so close feels responsive
 */
export function PlayerDetailModal({
  open,
  onClose,
  prop,
  selectedSide,
  onToggleSide,
  moreP,
  lessP,
}: PlayerDetailModalProps) {
  const projection = useProjectionStore((s) => s.byProp[prop.id]);

  // Escape-to-close — standard modal affordance. Bind only when open so the
  // background page doesn't subscribe to every keystroke.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Lock body scroll while the modal is open so the page behind doesn't drift.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Recent game values from the real projection model. When we don't have a
  // real projection (still fetching, or PrizePicks served a stat we can't
  // gamelog yet) we fall back to an empty chart with an "awaiting gamelog"
  // hint so the modal still opens informatively.
  const recent = projection && projection.available ? projection.recent : [];
  const projectionMean =
    projection && projection.available ? projection.projection : prop.line;
  // Last 5 games, chronological left→right so the most recent reads on the
  // right (the convention PrizePicks uses).
  const last5 = recent.slice(-5);
  const last5Avg =
    last5.length > 0 ? last5.reduce((a, b) => a + b, 0) / last5.length : 0;

  // Bar chart geometry — chartMax pads above the highest value so the tallest
  // bar doesn't clip the projection line.
  const chartMax = Math.max(...last5, prop.line, projectionMean) * 1.15 || 10;
  // Y-axis tick values for the gridlines + axis labels (nice whole numbers).
  const tick3 = Math.round(chartMax);
  const tick2 = Math.round(chartMax * 0.66);
  const tick1 = Math.round(chartMax * 0.33);

  // Subtitle: team · position · vs opponent. Falls back gracefully on missing
  // fields so the modal still reads cleanly.
  const gameTimeLabel = (() => {
    if (!prop.gameTime) return "";
    const d = new Date(prop.gameTime);
    if (isNaN(d.getTime())) return "";
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${day} ${time}`;
  })();
  const subtitleParts = [
    prop.team,
    prop.playerPosition ? prop.playerPosition : null,
  ].filter(Boolean);
  const opponentLabel = prop.opponent ? `vs ${prop.opponent}` : "";

  // PrizePicks rule: demon/goblin are MORE-only. Disable the LESS button for
  // those odds types instead of hiding it — keeps the layout stable and
  // surfaces the rule via the disabled visual + "More only" hint.
  const moreOnly = prop.oddsType !== "standard";

  const initials = prop.playerName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();

  // Portal target — we render the modal at document.body so it escapes any
  // ancestor `transform` / `filter` / `perspective` (PropBox uses motion.div
  // with transforms, which would re-base `position: fixed` to the card's
  // bounding box and visually trap the modal inside the card). The mounted
  // state guards SSR — document is undefined on the server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;

  const modal = (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — click to dismiss. Split from the sheet so framer-motion
              can animate them independently (scrim fades, sheet slides). */}
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md"
            onClick={onClose}
            aria-hidden
          />

          {/* Sheet — full viewport, slide up + fade for spatial entrance.
              role/aria on this element so screen readers announce it as a
              modal dialog. */}
          <motion.div
            key="sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="player-detail-title"
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16, transition: { duration: 0.18 } }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            className="fixed inset-0 z-50 overflow-y-auto"
            onClick={onClose}
          >
            {/* Close button — fixed to the viewport so it stays put while the
                sheet scrolls. Touch-target ≥44px. */}
            <button
              onClick={onClose}
              aria-label="Close player detail"
              className="fixed top-5 right-5 md:top-8 md:right-8 w-11 h-11 rounded-full border-2 border-white/25 text-white/85 hover:text-white hover:border-white hover:bg-white/10 transition-colors flex items-center justify-center z-[60] bg-[#0D0D1A]/80 backdrop-blur focus:outline-none focus:ring-2 focus:ring-[#FFE600]"
            >
              <X size={20} strokeWidth={2.5} aria-hidden />
            </button>

            <div
              onClick={(e) => e.stopPropagation()}
              className="min-h-full w-full px-5 py-10 md:px-12 md:py-14 lg:px-20 lg:py-16"
            >
              <div className="mx-auto w-full max-w-5xl">
                {/* ─────────────────────────── HEADER ─────────────────────────── */}
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-8 md:gap-10 items-start mb-10 md:mb-12">
                  {/* Headshot + meta (left of header row) */}
                  <div className="flex items-center gap-5 md:gap-6">
                    <motion.div
                      initial={{ scale: 0.85, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", damping: 18, delay: 0.05 }}
                      className="relative w-20 h-20 md:w-24 md:h-24 rounded-full overflow-hidden bg-[#2D1B4E] flex items-center justify-center flex-shrink-0 border border-white/15"
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
                        className="absolute inset-0 flex items-center justify-center font-[family-name:var(--font-heading)] font-black text-2xl text-white/80"
                        style={{ display: prop.playerImage ? "none" : "flex" }}
                      >
                        {initials || <User2 size={36} strokeWidth={3} />}
                      </div>
                    </motion.div>

                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.1, duration: 0.25 }}
                      className="min-w-0"
                    >
                      <h2
                        id="player-detail-title"
                        className="font-[family-name:var(--font-heading)] font-black text-3xl md:text-5xl uppercase tracking-tight leading-[0.95] text-white"
                      >
                        {prop.playerName}
                      </h2>
                      <div className="text-white/65 text-xs md:text-sm mt-3 uppercase tracking-widest font-bold">
                        {subtitleParts.join(" · ")}
                        {opponentLabel ? <> · {opponentLabel}</> : null}
                      </div>
                      {gameTimeLabel && (
                        <div className="text-white/50 text-[11px] md:text-xs mt-1.5 font-bold">
                          {gameTimeLabel}
                        </div>
                      )}
                      <div className="mt-4 flex items-center gap-2">
                        <OddsBadge oddsType={prop.oddsType} />
                        {moreOnly && (
                          <span className="text-[10px] text-white/55 font-bold uppercase tracking-widest">
                            More only
                          </span>
                        )}
                      </div>
                    </motion.div>
                  </div>

                  {/* Line tile + MORE/LESS pill (right of header row) */}
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.15, duration: 0.3 }}
                    className="w-full md:w-auto md:min-w-[260px] rounded-2xl border-2 border-[#4ADE80] bg-[#0D0D1A] p-5"
                  >
                    <div className="text-center pb-4 border-b border-white/10">
                      <div className="font-[family-name:var(--font-display)] text-5xl md:text-6xl leading-none text-white">
                        {prop.line}
                      </div>
                      <div className="text-white/60 text-[11px] uppercase tracking-widest font-bold mt-2">
                        {prop.statType}
                      </div>
                    </div>

                    <div className="flex gap-2 mt-4">
                      <button
                        onClick={() => !moreOnly && onToggleSide("less")}
                        disabled={moreOnly}
                        aria-pressed={selectedSide === "less"}
                        aria-label={`Pick LESS on ${prop.playerName} ${prop.statType} ${prop.line}`}
                        className={cn(
                          "flex-1 px-3 py-2.5 rounded-lg text-sm font-[family-name:var(--font-heading)] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 transition-colors border-2",
                          selectedSide === "less"
                            ? "bg-[#F87171] border-[#F87171] text-[#0D0D1A]"
                            : moreOnly
                              ? "border-white/10 text-white/25 cursor-not-allowed"
                              : "border-[#F87171]/60 text-[#F87171] hover:bg-[#F87171]/10",
                        )}
                      >
                        <TrendingDown size={14} strokeWidth={3} aria-hidden />
                        Less
                        {lessP !== null && !moreOnly && (
                          <span className="text-[10px] opacity-80 ml-0.5">{lessP.toFixed(0)}%</span>
                        )}
                      </button>
                      <button
                        onClick={() => onToggleSide("more")}
                        aria-pressed={selectedSide === "more"}
                        aria-label={`Pick MORE on ${prop.playerName} ${prop.statType} ${prop.line}`}
                        className={cn(
                          "flex-1 px-3 py-2.5 rounded-lg text-sm font-[family-name:var(--font-heading)] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 transition-colors border-2",
                          selectedSide === "more"
                            ? "bg-[#4ADE80] border-[#4ADE80] text-[#0D0D1A]"
                            : "border-[#4ADE80]/60 text-[#4ADE80] hover:bg-[#4ADE80]/10",
                        )}
                      >
                        <TrendingUp size={14} strokeWidth={3} aria-hidden />
                        More
                        {moreP !== null && (
                          <span className="text-[10px] opacity-80 ml-0.5">{moreP.toFixed(0)}%</span>
                        )}
                      </button>
                    </div>
                  </motion.div>
                </div>

                {/* ─────────────────────── CHART + PER-GAME TABLE ─────────────────────── */}
                {last5.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-14 items-start">
                    {/* LEFT: Chart + Avg tile */}
                    <motion.div
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2, duration: 0.3 }}
                    >
                      <div className="text-white/55 text-[10px] uppercase tracking-widest font-bold mb-4">
                        Last {last5.length} games · {prop.statType}
                      </div>

                      {/* Plot area */}
                      <div className="relative h-[260px] md:h-[300px]">
                        {/* Y-axis labels */}
                        <div
                          aria-hidden
                          className="absolute left-0 top-0 bottom-0 flex flex-col justify-between font-[family-name:var(--font-display)] text-[11px] text-white/40 pr-3 w-8 text-right"
                        >
                          <span>{tick3}</span>
                          <span>{tick2}</span>
                          <span>{tick1}</span>
                          <span>0</span>
                        </div>

                        {/* Gridlines */}
                        <div
                          aria-hidden
                          className="absolute left-8 right-0 top-0 bottom-0 flex flex-col justify-between pointer-events-none"
                        >
                          {[0, 1, 2, 3].map((i) => (
                            <div key={i} className="h-px bg-white/10" />
                          ))}
                        </div>

                        {/* Bars */}
                        <div className="absolute left-8 right-0 bottom-0 top-0 flex items-end gap-3 md:gap-5 px-1">
                          {last5.map((value, i) => {
                            const heightPct = Math.max(2, (value / chartMax) * 100);
                            const hitsLine = value >= prop.line;
                            return (
                              <div key={i} className="relative flex-1 flex flex-col items-center justify-end h-full">
                                <motion.span
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  transition={{ delay: 0.4 + i * 0.05, duration: 0.2 }}
                                  className="font-[family-name:var(--font-display)] text-sm text-white/90 mb-1.5"
                                >
                                  {value}
                                </motion.span>
                                <motion.div
                                  initial={{ scaleY: 0 }}
                                  animate={{ scaleY: 1 }}
                                  transition={{
                                    delay: 0.25 + i * 0.06,
                                    duration: 0.45,
                                    ease: [0.22, 1, 0.36, 1],
                                  }}
                                  style={{ height: `${heightPct}%`, transformOrigin: "bottom" }}
                                  className={cn(
                                    "w-full rounded-t-md",
                                    hitsLine ? "bg-[#4ADE80]" : "bg-[#F87171]",
                                  )}
                                  aria-label={`Game ${i + 1}: ${value} ${prop.statType}`}
                                />
                              </div>
                            );
                          })}
                        </div>

                        {/* Dashed projection line — animates in after bars */}
                        <motion.div
                          initial={{ scaleX: 0, opacity: 0 }}
                          animate={{ scaleX: 1, opacity: 1 }}
                          transition={{ delay: 0.65, duration: 0.4 }}
                          style={{
                            bottom: `${(projectionMean / chartMax) * 100}%`,
                            transformOrigin: "left",
                          }}
                          className="absolute left-8 right-0 border-t-2 border-dashed border-white/60 pointer-events-none"
                        >
                          <span className="absolute right-0 -top-3 translate-y-[-50%] bg-[#0D0D1A] px-1.5 text-[10px] font-bold uppercase tracking-widest text-white/80">
                            Proj. {projectionMean.toFixed(1)}
                          </span>
                        </motion.div>
                      </div>

                      {/* Avg Last 5 tile */}
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.7, duration: 0.25 }}
                        className="mt-8 rounded-xl border border-white/10 bg-white/[0.04] px-5 py-4 text-center"
                      >
                        <div className="text-white/55 text-[10px] uppercase tracking-widest font-bold">
                          Avg. Last {last5.length}
                        </div>
                        <div className="font-[family-name:var(--font-display)] text-4xl text-white mt-1 leading-none">
                          {last5Avg.toFixed(2)}
                        </div>
                      </motion.div>
                    </motion.div>

                    {/* RIGHT: Per-game table */}
                    <motion.div
                      initial="hidden"
                      animate="visible"
                      variants={{
                        hidden: {},
                        visible: { transition: { staggerChildren: 0.05, delayChildren: 0.4 } },
                      }}
                    >
                      {/* Table header */}
                      <div className="grid grid-cols-[1fr_1fr_auto] gap-4 pb-3 border-b border-white/10 text-white/55 text-[10px] uppercase tracking-widest font-bold">
                        <div>Day</div>
                        <div>Opp</div>
                        <div className="text-right">{prop.statType}</div>
                      </div>
                      <div className="divide-y divide-white/5">
                        {[...last5].reverse().map((value, i) => {
                          const hits = value >= prop.line;
                          // We don't have per-game date/opponent in
                          // ProjectionResult.recent — show a synthetic
                          // "Game N" label (Game 1 = most recent).
                          const idx = last5.length - i;
                          return (
                            <motion.div
                              key={i}
                              variants={{
                                hidden: { opacity: 0, x: 10 },
                                visible: { opacity: 1, x: 0 },
                              }}
                              className="grid grid-cols-[1fr_1fr_auto] gap-4 items-center py-3"
                            >
                              <span className="text-white/85 text-sm font-bold uppercase tracking-wider">
                                Game {idx}
                                {i === 0 && (
                                  <span className="ml-1.5 text-[9px] text-[#FFE600]">(latest)</span>
                                )}
                              </span>
                              <span className="text-white/55 text-sm font-bold uppercase tracking-wider">
                                {opponentLabel || "—"}
                              </span>
                              <span
                                className={cn(
                                  "font-[family-name:var(--font-display)] text-2xl text-right",
                                  hits ? "text-[#4ADE80]" : "text-[#F87171]",
                                )}
                              >
                                {value}
                              </span>
                            </motion.div>
                          );
                        })}
                      </div>
                    </motion.div>
                  </div>
                ) : (
                  // No gamelog yet — friendly empty state so the modal still
                  // feels alive. Common for stats PP ships that we don't have
                  // a gamelog source for (yet).
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.15, duration: 0.25 }}
                    className="rounded-2xl border-2 border-dashed border-white/15 px-8 py-16 text-center max-w-2xl mx-auto"
                  >
                    <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white/65 text-sm">
                      No gamelog data yet
                    </div>
                    <p className="text-white/45 text-xs mt-3 max-w-md mx-auto leading-relaxed">
                      We&apos;re still fetching this player&apos;s recent games — usually a few
                      seconds. If this stays empty, the {prop.sport} stat type doesn&apos;t have a
                      gamelog source plumbed in yet (only NBA / WNBA / MLB do).
                    </p>
                  </motion.div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}
