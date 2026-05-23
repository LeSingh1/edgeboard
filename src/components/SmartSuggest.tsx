"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Trophy, Sparkles, ChevronDown, TrendingUp, TrendingDown, Zap, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import {
  recommendLineups,
  type FilterOptions,
  type SizeRecommendation,
} from "@/lib/optimizer";
import { OddsBadge } from "@/components/OddsBadge";
import type { VariantSet } from "@/lib/variantGroups";
import { accentHexFor, cn } from "@/lib/cn";
import type { PlayType, Prop, RiskMode } from "@/lib/types";

interface SmartSuggestProps {
  selectedProps: Prop[];
  entryCost: number;
  riskMode: RiskMode;
  variantsByPropId?: Record<string, VariantSet>;
  filters: FilterOptions;
  currentSize: number;
  onApply: (size: number) => void;
}

export function SmartSuggest({
  selectedProps,
  entryCost,
  riskMode,
  variantsByPropId,
  filters,
  currentSize,
  onApply,
}: SmartSuggestProps) {
  const result = useMemo(
    () =>
      recommendLineups({
        selectedProps,
        entryCost,
        riskMode,
        variantsByPropId,
        filters,
      }),
    [selectedProps, entryCost, riskMode, variantsByPropId, filters],
  );

  const [expandedSize, setExpandedSize] = useState<number | null>(
    result.recommended?.size ?? null,
  );

  if (!result.bySize.length) return null;

  const modeLabel =
    riskMode === "safe"
      ? "highest chance of hitting"
      : riskMode === "aggressive"
        ? "highest avg $ per play"
        : "best avg $ (≥ 10% hit chance)";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-3xl border-4 border-[#00F5D4] bg-gradient-to-br from-[#00F5D4]/10 via-[#7B2FFF]/10 to-[#FF3AF2]/10 backdrop-blur-sm overflow-hidden"
    >
      <div className="p-6 md:p-8">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
          <div className="flex items-center gap-2">
            <Sparkles size={22} strokeWidth={3} className="text-[#00F5D4]" aria-hidden />
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-2xl text-shadow-1">
              Smart suggest
            </h2>
          </div>
          <div className="px-3 py-1 rounded-full border-2 border-[#FFE600] text-[#FFE600] text-[10px] font-black uppercase tracking-widest">
            Picking by: {modeLabel}
          </div>
        </div>
        <p className="text-white/60 text-sm mb-5">
          For each lineup size, the optimizer searched every C(N, k) × 2<sup>k</sup> combination
          of your {selectedProps.length} picks. Tap a card to see exactly which picks make up that
          size&apos;s best slip.
        </p>

        {/* Quick-scan grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
          {result.bySize.map((rec, i) => {
            const isRec = result.recommended?.size === rec.size;
            const isCurrent = currentSize === rec.size;
            const isExpanded = expandedSize === rec.size;
            return (
              <SuggestCardWithToggle
                key={rec.size}
                rec={rec}
                isRecommended={isRec}
                isCurrent={isCurrent}
                isExpanded={isExpanded}
                accent={accentHexFor(i)}
                accent2={accentHexFor(i + 2)}
                onToggle={() => setExpandedSize(isExpanded ? null : rec.size)}
                onApply={() => onApply(rec.size)}
              />
            );
          })}
        </div>

        {/* Play-type variety note */}
        <PlayTypeMixSummary recs={result.bySize} />

        {/* Expanded detail panel — shows the actual picks in the focused size's best slip.
            Guarded: if the underlying recs recomputed (picks changed) and the previously
            expanded size is no longer present, the find returns undefined — we just don't
            render rather than crashing on `rec.best`. */}
        <AnimatePresence mode="wait">
          {(() => {
            if (expandedSize === null) return null;
            const expandedRec = result.bySize.find((s) => s.size === expandedSize);
            if (!expandedRec) return null;
            return (
              <SuggestDetail
                key={expandedSize}
                rec={expandedRec}
                isRecommended={result.recommended?.size === expandedSize}
                isCurrent={currentSize === expandedSize}
                onApply={() => onApply(expandedSize)}
              />
            );
          })()}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/** Tiny pill that names the play type for a lineup (Power vs Flex).
 *  When `onCycle` is provided, becomes a clickable button that cycles
 *  Auto → Power → Flex → Auto so the user can override the auto choice
 *  on a per-card basis. The label gets a small "(forced)" marker so it's
 *  obvious the user overrode the optimizer. */
function PlayTypePill({
  playType,
  compact = true,
  override,
  flexAvailable,
  onCycle,
}: {
  playType: PlayType;
  compact?: boolean;
  /** Current override state. "auto" = whatever recommendLineups chose. */
  override?: PlayType | "auto";
  /** Whether Flex is a valid option (size ≥ 3 + a valid Flex lineup exists). */
  flexAvailable?: boolean;
  /** When provided, the pill becomes a button. Cycles play-type override. */
  onCycle?: (e: React.MouseEvent) => void;
}) {
  const isPower = playType === "power";
  const isForced = override !== undefined && override !== "auto";
  const baseClass = cn(
    "inline-flex items-center gap-1 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase tracking-widest transition-colors",
    compact ? "px-1.5 py-0 text-[8px]" : "px-2 py-0.5 text-[10px]",
    onCycle && "cursor-pointer hover:brightness-125",
  );
  const style = {
    borderColor: isPower ? "#7B2FFF" : "#00F5D4",
    color: isPower ? "#7B2FFF" : "#00F5D4",
    background: isPower ? "rgba(123,47,255,0.12)" : "rgba(0,245,212,0.12)",
  };
  const title = onCycle
    ? `Click to switch — auto / power / flex${!flexAvailable ? " (flex needs 3+ picks)" : ""}`
    : isPower
      ? "Power — every pick must hit. Bigger payout, no safety net."
      : "Flex — partial hits still pay (e.g. 3/4 wins). Smaller multipliers.";
  const inner = (
    <>
      {isPower ? <Zap size={9} strokeWidth={3} aria-hidden /> : <Layers size={9} strokeWidth={3} aria-hidden />}
      {isPower ? "Power" : "Flex"}
      {isForced && <span aria-hidden className="ml-0.5 opacity-60">·</span>}
    </>
  );
  if (onCycle) {
    return (
      <button
        type="button"
        onClick={onCycle}
        aria-label={`Play type: ${isPower ? "Power" : "Flex"}${isForced ? " (forced)" : " (auto)"}. Click to cycle.`}
        title={title}
        className={baseClass}
        style={style}
      >
        {inner}
      </button>
    );
  }
  return (
    <span title={title} className={baseClass} style={style}>
      {inner}
    </span>
  );
}

/** Tells the user how many sizes auto-chose Power vs Flex so they see the variety. */
function PlayTypeMixSummary({ recs }: { recs: SizeRecommendation[] }) {
  const valid = recs.filter((r) => r.best);
  if (valid.length === 0) return null;
  const power = valid.filter((r) => r.playType === "power").length;
  const flex = valid.filter((r) => r.playType === "flex").length;
  if (power === 0 || flex === 0) {
    return (
      <p className="text-white/40 text-[11px] uppercase tracking-widest font-bold mb-4">
        Every size auto-chose <span className="text-white/70">{power > 0 ? "Power" : "Flex"}</span>
        {" "}— that&apos;s the higher avg-$ path for these picks.
      </p>
    );
  }
  return (
    <p className="text-white/50 text-[11px] uppercase tracking-widest font-bold mb-4">
      Mixed play types: <span className="text-[#7B2FFF]">{power} Power</span> ·{" "}
      <span className="text-[#00F5D4]">{flex} Flex</span> · auto-chosen per size by avg $
    </p>
  );
}

/**
 * Card wrapper that holds the per-card play-type override state. The user
 * can click the play-type pill to flip between Power and Flex; the card
 * re-reads `rec.bestPower` / `rec.bestFlex` (already computed by
 * recommendLineups) so flipping is free — no re-optimization.
 *
 * "Auto" leaves the choice to recommendLineups. "Power" / "Flex" forces.
 * If the forced play type has no valid lineup (e.g. Flex on a 2-pick),
 * the card falls back to `auto` so we never render an empty card.
 */
function SuggestCardWithToggle(props: {
  rec: SizeRecommendation;
  isRecommended: boolean;
  isCurrent: boolean;
  isExpanded: boolean;
  accent: string;
  accent2: string;
  onToggle: () => void;
  onApply: () => void;
}) {
  const { rec } = props;
  const [override, setOverride] = useState<PlayType | "auto">("auto");

  // Resolve which lineup to display based on the override.
  let displayed: SizeRecommendation = rec;
  if (override === "power" && rec.bestPower) {
    displayed = { ...rec, best: rec.bestPower, playType: "power" };
  } else if (override === "flex" && rec.bestFlex) {
    displayed = { ...rec, best: rec.bestFlex, playType: "flex" };
  }

  // Flex is only valid for size 3+. Power is always valid.
  const flexAvailable = rec.size >= 3 && rec.bestFlex !== null;

  const cyclePlayType = (e: React.MouseEvent) => {
    e.stopPropagation(); // don't toggle the expansion panel
    if (override === "auto") setOverride("power");
    else if (override === "power") setOverride(flexAvailable ? "flex" : "auto");
    else setOverride("auto");
  };

  return <SuggestCard {...props} rec={displayed} override={override} flexAvailable={flexAvailable} onCyclePlayType={cyclePlayType} />;
}

function SuggestCard({
  rec,
  isRecommended,
  isCurrent,
  isExpanded,
  accent,
  accent2,
  onToggle,
  onApply,
  override,
  flexAvailable,
  onCyclePlayType,
}: {
  rec: SizeRecommendation;
  isRecommended: boolean;
  isCurrent: boolean;
  isExpanded: boolean;
  accent: string;
  accent2: string;
  onToggle: () => void;
  onApply: () => void;
  override: PlayType | "auto";
  flexAvailable: boolean;
  onCyclePlayType: (e: React.MouseEvent) => void;
}) {
  const best = rec.best;
  if (!best) {
    return (
      <div className="relative rounded-2xl border-4 border-dashed border-white/15 p-3 text-white/30 text-xs uppercase font-black tracking-widest opacity-60">
        {rec.size}-pick<br />no valid slips
      </div>
    );
  }
  const hitColor =
    best.hitProbability >= 0.25 ? "#4ADE80" : best.hitProbability >= 0.10 ? "#FFE600" : "#F87171";
  const evColor = best.expectedValue >= 0 ? "#4ADE80" : "#F87171";

  return (
    <motion.div
      layout
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      onClick={onToggle}
      onDoubleClick={onApply}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-pressed={isExpanded}
      aria-label={`${rec.size}-pick ${rec.playType}: ${(best.hitProbability * 100).toFixed(1)} percent chance of hitting, ${best.expectedValue.toFixed(2)} dollars average per play. ${isRecommended ? "Recommended pick." : ""} Tap to see which picks are in this slip; double-tap to apply.`}
      className={cn(
        // overflow-visible — the "PICK" badge sits at -top-2 -right-2 and
        // would clip otherwise. Padding-top reserves space for the badge.
        "relative rounded-2xl border-4 pt-4 px-3 pb-3 text-left cursor-pointer",
        "focus:outline-none focus:ring-4 focus:ring-offset-2 focus:ring-offset-[#0D0D1A]",
        isCurrent && "ring-4 ring-[#FFE600] ring-offset-2 ring-offset-[#0D0D1A]",
      )}
      style={{
        borderColor: isRecommended ? "#FFE600" : accent,
        background: isExpanded
          ? "rgba(0,245,212,0.15)"
          : isRecommended
            ? "rgba(255,230,0,0.10)"
            : "rgba(13,13,26,0.5)",
        boxShadow: isRecommended
          ? `3px 3px 0 ${accent}, 6px 6px 0 ${accent2}, 0 0 30px rgba(255,230,0,0.4)`
          : `3px 3px 0 ${accent2}`,
      }}
    >
      {isRecommended && (
        <span className="absolute -top-2 right-2 bg-[#FFE600] text-[#0D0D1A] rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest border-2 border-[#0D0D1A] z-10">
          Pick
        </span>
      )}
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] uppercase tracking-widest font-bold text-white/60">
          {rec.size}-pick
        </span>
        <PlayTypePill
          playType={rec.playType}
          override={override}
          flexAvailable={flexAvailable}
          onCycle={onCyclePlayType}
        />
        <ChevronDown
          size={14}
          strokeWidth={3}
          className={cn(
            "text-white/40 transition-transform",
            isExpanded && "rotate-180 text-[#00F5D4]",
          )}
          aria-hidden
        />
      </div>
      <div
        className="font-[family-name:var(--font-display)] text-3xl leading-none mt-1"
        style={{ color: hitColor }}
      >
        {(best.hitProbability * 100).toFixed(1)}%
      </div>
      <div className="text-[10px] text-white/60 font-bold uppercase tracking-wider mt-0.5">
        chance to hit
      </div>
      <div className="mt-2 flex items-baseline gap-1" title="Average dollars you'd make per play if you ran this exact slip many times.">
        <span
          className="font-[family-name:var(--font-heading)] font-black text-base"
          style={{ color: evColor }}
        >
          {best.expectedValue >= 0 ? "+" : ""}${best.expectedValue.toFixed(2)}
        </span>
        <span className="text-[9px] text-white/50 uppercase">avg $</span>
      </div>
      <div className="text-[9px] text-white/40 mt-1 font-bold uppercase tracking-wider">
        {best.payoutMultiplier.toFixed(2)}× payout
      </div>
      <div className="text-[8px] text-white/40 mt-1.5 font-bold tracking-wider" title="How many of the slips at this size make money long-term.">
        {rec.countPositiveEv} of {rec.totalEvaluated} make money
      </div>
    </motion.div>
  );
}

function SuggestDetail({
  rec,
  isRecommended,
  isCurrent,
  onApply,
}: {
  rec: SizeRecommendation;
  isRecommended: boolean;
  isCurrent: boolean;
  onApply: () => void;
}) {
  // Defensive: rec can be undefined if the parent passes a stale lookup result
  // (e.g. recs recomputed under us). Guard before touching .best.
  if (!rec) return null;
  const best = rec.best;
  if (!best) return null;

  const hitColor =
    best.hitProbability >= 0.25 ? "#4ADE80" : best.hitProbability >= 0.10 ? "#FFE600" : "#F87171";
  const evColor = best.expectedValue >= 0 ? "#4ADE80" : "#F87171";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, y: 10, height: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden"
    >
      <div
        className="rounded-2xl border-4 border-dashed border-[#FFE600] bg-[#FFE600]/5 p-5"
      >
        <div className="flex items-start gap-3 flex-wrap mb-4">
          <Trophy size={24} strokeWidth={3} className="text-[#FFE600] flex-shrink-0 mt-0.5" aria-hidden />
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#FFE600] text-xs">
                {isRecommended ? "Recommendation" : "Best slip at this size"}
              </span>
              <span className="text-white/60 text-xs">·</span>
              <span className="font-[family-name:var(--font-heading)] font-black uppercase text-xs text-white tracking-widest">
                {rec.size}-pick
              </span>
              <PlayTypePill playType={rec.playType} compact={false} />
            </div>
            <div className="mt-2 flex flex-wrap gap-3 items-baseline">
              <div>
                <div className="text-[9px] text-white/50 uppercase tracking-widest font-bold">
                  Chance to hit
                </div>
                <div
                  className="font-[family-name:var(--font-heading)] font-black text-2xl"
                  style={{ color: hitColor }}
                >
                  {(best.hitProbability * 100).toFixed(1)}%
                </div>
              </div>
              <div title="Average dollars you'd make per play if you ran this exact slip many times.">
                <div className="text-[9px] text-white/50 uppercase tracking-widest font-bold">
                  Avg $ per play
                </div>
                <div
                  className="font-[family-name:var(--font-heading)] font-black text-2xl"
                  style={{ color: evColor }}
                >
                  {best.expectedValue >= 0 ? "+" : ""}${best.expectedValue.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[9px] text-white/50 uppercase tracking-widest font-bold">
                  Payout
                </div>
                <div className="font-[family-name:var(--font-heading)] font-black text-2xl text-[#00F5D4]">
                  {best.payoutMultiplier.toFixed(2)}×
                </div>
              </div>
              <div>
                <div className="text-[9px] text-white/50 uppercase tracking-widest font-bold">
                  Gross if hit
                </div>
                <div className="font-[family-name:var(--font-heading)] font-black text-2xl text-[#FFE600]">
                  ${best.grossPayout.toFixed(0)}
                </div>
              </div>
            </div>
            {best.expectedValue > 0 ? (
              <p className="text-[#4ADE80] text-xs mt-2 font-bold uppercase tracking-wider">
                ✓ Profitable long-term — makes money on average across many plays. Not a single-slip guarantee.
              </p>
            ) : (
              <p className="text-[#F87171] text-xs mt-2 font-bold uppercase tracking-wider">
                ✗ Loses long-term — PrizePicks keeps more than this slip pays back at these odds.
              </p>
            )}
          </div>
        </div>

        {/* The actual picks */}
        <div className="border-t-2 border-dashed border-[#FFE600]/30 pt-4">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#FFE600] text-xs mb-3">
            Which of your picks to use ({best.picks.length}):
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {best.picks.map((pick, i) => {
              const isMore = pick.side === "more";
              return (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-xl border-2 px-3 py-2 bg-[#0D0D1A]/40"
                  style={{
                    borderColor: isMore ? "#4ADE80" : "#F87171",
                  }}
                >
                  {/* Headshot */}
                  <div
                    className="w-9 h-9 rounded-full border-2 overflow-hidden flex-shrink-0 bg-[#0D0D1A]"
                    style={{ borderColor: isMore ? "#4ADE80" : "#F87171" }}
                  >
                    {pick.prop.playerImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={pick.prop.playerImage}
                        alt={pick.prop.playerName}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "w-7 h-7 rounded-lg border-2 flex items-center justify-center flex-shrink-0 font-black uppercase text-[10px]",
                      isMore ? "border-[#4ADE80] text-[#4ADE80]" : "border-[#F87171] text-[#F87171]",
                    )}
                  >
                    {isMore ? <TrendingUp size={12} strokeWidth={3} /> : <TrendingDown size={12} strokeWidth={3} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-[family-name:var(--font-heading)] font-black uppercase text-xs text-white truncate">
                        {pick.prop.playerName}
                      </span>
                      <OddsBadge oddsType={pick.prop.oddsType} compact />
                    </div>
                    <div className="text-white/60 text-[10px] truncate">
                      {pick.side === "more" ? "MORE" : "LESS"} {pick.prop.line}{" "}
                      {pick.prop.statType}{" "}
                      <span className="text-white/40">· {(pick.probability * 100).toFixed(0)}%</span>
                    </div>
                    <div
                      className="text-[9px] font-bold uppercase tracking-widest mt-0.5"
                      style={{
                        color:
                          pick.prop.oddsType === "goblin"
                            ? "#4ADE80"
                            : pick.prop.oddsType === "demon"
                              ? "#FF6B35"
                              : "#FFE600",
                      }}
                      title={
                        pick.prop.oddsType === "goblin"
                          ? "Use the GOBLIN line for this pick — 0.85× payout, higher hit %"
                          : pick.prop.oddsType === "demon"
                            ? "Use the DEMON line for this pick — 1.5× payout, lower hit %"
                            : "Use the STANDARD line for this pick"
                      }
                    >
                      Use {pick.prop.oddsType} line
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Apply CTA */}
        <div className="mt-5 flex flex-wrap gap-3 items-center">
          <button
            onClick={onApply}
            className={cn(
              "px-6 h-12 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-sm flex items-center gap-2",
              "hover:scale-105 active:scale-95 transition-transform focus:outline-none focus:ring-4 focus:ring-[#FFE600]/60",
              isCurrent && "opacity-60 cursor-default",
            )}
            disabled={isCurrent}
          >
            {isCurrent ? "Already selected" : `Apply ${rec.size}-pick to optimizer`}
          </button>
          <span className="text-white/50 text-xs">
            Then click Generate Leaderboard below to see this slip + alternates ranked.
          </span>
        </div>
      </div>
    </motion.div>
  );
}
