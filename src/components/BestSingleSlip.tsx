"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight, TrendingUp, TrendingDown, Trophy, Target, Zap, Layers } from "lucide-react";
import { recommendLineups, meetsTeamDiversity, enterablePick } from "@/lib/optimizer";
import { useLineupStore } from "@/stores/lineupStore";
import type { PlayType, Prop, RiskMode } from "@/lib/types";
import type { VariantSet } from "@/lib/variantGroups";
import { OddsBadge } from "@/components/OddsBadge";
import { AnimatedPercent } from "@/components/AnimatedPercent";
import { cn } from "@/lib/cn";

interface BestSingleSlipProps {
  /** The user's current bench, in patched form (real-projection probabilities). */
  selectedProps: Prop[];
  /** Dollar amount per slip the user has dialed in. Drives payout / EV math. */
  entryCost: number;
  /** Variant ladders so the optimizer can swap goblin↔standard↔demon to find
   *  a better single slip than the bench as-is. Without this, variants are
   *  locked to whatever the user picked. */
  variantsByPropId: Record<string, VariantSet>;
  /** Hit-% / EV cuts inherited from the parent controls. */
  filters: { minHitProb: number; minEv: number };
}

/**
 * Single-slip optimizer panel.
 *
 * Unlike SmartSuggest (which shows the best lineup at every size) and the main
 * Generate flow (which produces a ranked leaderboard of every combination),
 * this panel collapses the whole search down to ONE answer:
 *
 *   "Of every possible lineup I could build from these bench picks —
 *    every size, every variant swap, power or flex — which single slip
 *    has the highest probability of hitting?"
 *
 * This is the "I'm playing one slip tonight, which one?" view. We hard-code
 * `riskMode: "safe"` (sort by hit %) so the answer is unambiguous regardless
 * of what risk mode the user has selected for the multi-lineup flow.
 *
 * Hitting "Use this slip" pushes this lineup into the slip store as the only
 * result and navigates to /slips so the user can confirm and play it.
 */
export function BestSingleSlip({
  selectedProps,
  entryCost,
  variantsByPropId,
  filters,
}: BestSingleSlipProps) {
  const router = useRouter();
  const setResults = useLineupStore((s) => s.setResults);

  // Per-card overrides — the user can pin a specific lineup size or play
  // type, or leave both on "auto" to let the optimizer choose. Defaults
  // are "auto" / "auto", which reproduces the original single-answer
  // behavior. Forced choices that can't be honored (e.g. flex on a
  // 2-pick) fall back to power so we never render an empty card.
  const [sizeOverride, setSizeOverride] = useState<number | "auto">("auto");
  const [playOverride, setPlayOverride] = useState<PlayType | "auto">("auto");

  // recommendLineups already runs the cross-size + cross-play search and
  // returns best-Power / best-Flex per size, so flipping overrides costs
  // nothing — we just pick a different entry from the same result.
  const result = useMemo(() => {
    if (selectedProps.length < 2) return null;
    return recommendLineups({
      selectedProps,
      entryCost,
      riskMode: "safe" as RiskMode,
      variantsByPropId,
      filters,
    });
  }, [selectedProps, entryCost, variantsByPropId, filters]);

  // List of sizes the optimizer found a valid lineup for. Powers the
  // size-pill row — disabled sizes are still rendered (so the bar doesn't
  // jump) but they can't be selected.
  const availableSizes = useMemo(
    () => (result ? result.bySize.filter((s) => s.best !== null).map((s) => s.size) : []),
    [result],
  );

  // ── Derive "effective" overrides during render rather than snapping the
  // underlying state via effects (which would cascade-render and fight
  // the react-hooks/set-state-in-effect rule). If the user pinned a size
  // that's no longer valid (e.g. they removed a pick), the pill UI shows
  // the effective value and the resolution falls back to auto. The raw
  // pinned state is preserved so re-adding the pick restores their pin.
  const effectiveSizeOverride: number | "auto" =
    sizeOverride !== "auto" && availableSizes.includes(sizeOverride)
      ? sizeOverride
      : "auto";

  // Resolve the displayed lineup by walking the override matrix.
  const best = useMemo(() => {
    if (!result) return null;
    // 1. Pick which size's recommendation we're looking at.
    const sizeRec =
      effectiveSizeOverride === "auto"
        ? result.recommended
        : result.bySize.find((s) => s.size === effectiveSizeOverride) ?? result.recommended;
    if (!sizeRec) return null;
    // 2. Within that size, honor the play-type override.
    if (playOverride === "power" && sizeRec.bestPower) return sizeRec.bestPower;
    if (playOverride === "flex" && sizeRec.bestFlex) return sizeRec.bestFlex;
    return sizeRec.best;
  }, [result, effectiveSizeOverride, playOverride]);

  // Determine which play types are actually available for the currently
  // chosen size — Flex only exists for size ≥ 3 and when a valid Flex
  // lineup was generated. This drives whether the Flex button is
  // selectable.
  const flexAvailable = useMemo(() => {
    if (!result) return false;
    const sizeRec =
      effectiveSizeOverride === "auto"
        ? result.recommended
        : result.bySize.find((s) => s.size === effectiveSizeOverride);
    return !!(sizeRec && sizeRec.bestFlex);
  }, [result, effectiveSizeOverride]);

  // Same trick for play-type — show the effective value, keep the pin
  // around so it re-engages when the size changes back to one that
  // supports Flex.
  const effectivePlayOverride: PlayType | "auto" =
    playOverride === "flex" && !flexAvailable ? "auto" : playOverride;

  // Empty state — pick apart the reason so the user knows what to do.
  // The optimizer can return null because:
  //   1. Fewer than 2 picks on the bench
  //   2. Bench has 2+ picks but they all share a single team — PrizePicks
  //      rejects same-team-only lineups, so no valid slip exists.
  if (!best) {
    const tooFew = selectedProps.length < 2;
    const sameTeamOnly = !tooFew && !meetsTeamDiversity(selectedProps);
    return (
      <motion.section
        layout
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-3xl border-4 border-dashed border-[#00F5D4]/50 bg-[#0D0D1A]/40 p-6 md:p-8 mb-10"
        aria-label="Best single slip — empty"
      >
        <div className="flex items-center gap-3 mb-2">
          <Target size={20} strokeWidth={3} className="text-[#00F5D4]" aria-hidden />
          <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm text-[#00F5D4]">
            One best slip
          </h2>
        </div>
        {sameTeamOnly ? (
          <p className="text-white/65 text-sm">
            <span className="text-[#F87171] font-bold">PrizePicks rule:</span>{" "}
            every lineup needs players from at least 2 different teams. Your
            bench is all one team right now — add a pick from another team to
            unlock a valid slip.
          </p>
        ) : (
          <p className="text-white/55 text-sm">
            Add 2 or more picks to your bench and we&apos;ll find the single lineup
            with the highest chance to hit.
          </p>
        )}
      </motion.section>
    );
  }

  // Color cue — green ≥ 25%, yellow ≥ 10%, red below. Matches the rest of
  // the app's traffic-light convention.
  const pctColor =
    best.hitProbability >= 0.25
      ? "#4ADE80"
      : best.hitProbability >= 0.10
        ? "#FFE600"
        : "#F87171";

  const profit = best.expectedValue;
  const evColor = profit >= 0 ? "#4ADE80" : "#F87171";

  // Push this single lineup into the slip store as the only result, then
  // navigate to /slips. We use the same shape the multi-lineup Generate
  // flow uses so the slips page renders it without any special-casing.
  const handleUse = () => {
    setResults({
      lineups: [best],
      totalGenerated: 1,
      elapsedMs: 0,
      params: {
        lineupSize: best.picks.length,
        playType: best.playType,
        entryCost,
        riskMode: "safe",
      },
    });
    router.push("/slips");
  };

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative rounded-3xl border-8 border-[#00F5D4] bg-gradient-to-br from-[#00F5D4]/15 via-[#7B2FFF]/10 to-[#FF3AF2]/15 backdrop-blur-sm overflow-hidden mb-10"
      aria-label="Best single slip"
    >
      {/* ── Header ── */}
      <div className="p-6 md:p-8 border-b-4 border-dashed border-[#00F5D4]/40">
        <div className="flex items-start gap-3 flex-wrap">
          <motion.div
            initial={{ rotate: -20, scale: 0.6 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: "spring", damping: 12, delay: 0.1 }}
            className="w-12 h-12 rounded-2xl bg-[#00F5D4] flex items-center justify-center flex-shrink-0"
          >
            <Trophy size={26} strokeWidth={3} className="text-[#0D0D1A]" aria-hidden />
          </motion.div>
          <div className="flex-1 min-w-[220px]">
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-3xl md:text-4xl text-white leading-none">
              One best slip
            </h2>
            <p className="text-white/65 text-sm mt-2 max-w-xl">
              We crunched every combination of your {selectedProps.length} picks across every variant ladder. Right now we&apos;re showing the
              <span className="text-[#00F5D4] font-bold"> {best.picks.length}-pick {best.playType} slip</span>
              {effectiveSizeOverride === "auto" && effectivePlayOverride === "auto"
                ? " with the highest chance to hit"
                : " you picked below"}
              . Mix and match size + play type to see your other options.
            </p>
          </div>
        </div>

        {/* ── Override controls: size + play type ──
            Both default to "Auto" (whatever recommendLineups picked). The
            user can pin a specific size and/or play type to compare. Pills
            for sizes that have no valid lineup (or play types that aren't
            available, e.g. Flex on 2-pick) are visibly disabled but stay in
            the layout so the row doesn't reflow. */}
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          {/* Size row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white/55 text-[10px] uppercase tracking-widest font-bold">
              Size
            </span>
            <PillToggle
              active={effectiveSizeOverride === "auto"}
              onClick={() => setSizeOverride("auto")}
              label="Auto"
              accent="#00F5D4"
            />
            {[2, 3, 4, 5, 6].map((s) => {
              const available = availableSizes.includes(s);
              return (
                <PillToggle
                  key={s}
                  active={effectiveSizeOverride === s}
                  disabled={!available}
                  onClick={() => available && setSizeOverride(s)}
                  label={`${s}-pick`}
                  accent="#00F5D4"
                />
              );
            })}
          </div>

          {/* Play type row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white/55 text-[10px] uppercase tracking-widest font-bold">
              Play
            </span>
            <PillToggle
              active={effectivePlayOverride === "auto"}
              onClick={() => setPlayOverride("auto")}
              label="Auto"
              accent="#FFE600"
            />
            <PillToggle
              active={effectivePlayOverride === "power"}
              onClick={() => setPlayOverride("power")}
              icon={<Zap size={11} strokeWidth={3} aria-hidden />}
              label="Power"
              accent="#7B2FFF"
              hint="All picks must hit. Bigger payout, no safety net."
            />
            <PillToggle
              active={effectivePlayOverride === "flex"}
              disabled={!flexAvailable}
              onClick={() => flexAvailable && setPlayOverride("flex")}
              icon={<Layers size={11} strokeWidth={3} aria-hidden />}
              label="Flex"
              accent="#00F5D4"
              hint={flexAvailable ? "Partial hits still pay (e.g. 3/4 wins)." : "Flex needs at least 3 picks in the slip."}
            />
          </div>
        </div>
      </div>

      {/* ── Headline stats row ── */}
      <div className="grid grid-cols-3 gap-3 md:gap-4 p-6 md:p-8 border-b-4 border-dashed border-[#00F5D4]/40">
        <Stat
          label="Hit %"
          value={
            // AnimatedPercent expects 0..1 — it multiplies by 100 internally.
            // Previously we passed hitProbability * 100, which double-scaled
            // (showed 9612.6% instead of 96.1%).
            <span style={{ color: pctColor }} className="block">
              <AnimatedPercent value={best.hitProbability} className="font-[family-name:var(--font-display)] text-4xl md:text-6xl leading-none" />
            </span>
          }
          accent={pctColor}
        />
        <Stat
          label="Payout"
          value={
            <div className="font-[family-name:var(--font-display)] text-4xl md:text-6xl leading-none text-white">
              ${best.grossPayout.toFixed(0)}
            </div>
          }
          accent="#FFE600"
          sub={`${best.payoutMultiplier.toFixed(2)}× on $${entryCost}`}
        />
        <Stat
          label="Avg profit"
          value={
            <div
              className="font-[family-name:var(--font-display)] text-4xl md:text-6xl leading-none"
              style={{ color: evColor }}
            >
              {profit >= 0 ? "+" : ""}${profit.toFixed(2)}
            </div>
          }
          accent={evColor}
          sub="Long-run $ per slip"
        />
      </div>

      {/* ── Pick composition ── */}
      <div className="p-6 md:p-8">
        <div className="text-white/55 text-[11px] uppercase tracking-widest font-bold mb-3 flex items-center gap-2">
          <Sparkles size={12} strokeWidth={3} aria-hidden />
          The slip · {best.picks.length} {best.playType === "power" ? "all-must-hit" : "flex (partial pays)"}
        </div>

        <ul className="grid gap-2.5">
          <AnimatePresence initial={false}>
            {best.picks.map((p, i) => {
              // MORE-only invariant: demon/goblin can't be entered on LESS.
              const norm = enterablePick(p.prop, p.side, p.probability);
              const isMore = norm.side === "more";
              const sideColor = isMore ? "#4ADE80" : "#F87171";
              const sideLabel = isMore ? "More" : "Less";
              const sideIcon = isMore ? TrendingUp : TrendingDown;
              const Icon = sideIcon;
              return (
                <motion.li
                  key={p.prop.id}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.1 + i * 0.04, duration: 0.25 }}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-white/10 bg-[#0D0D1A]/60 px-3 py-2.5"
                >
                  {/* Index bullet */}
                  <span
                    className="w-7 h-7 rounded-full border-2 flex items-center justify-center font-[family-name:var(--font-display)] text-sm text-white/85"
                    style={{ borderColor: sideColor }}
                    aria-hidden
                  >
                    {i + 1}
                  </span>

                  {/* Player + stat */}
                  <div className="min-w-0">
                    <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tight text-white truncate text-sm md:text-base">
                      {p.prop.playerName}
                    </div>
                    <div className="text-white/55 text-[11px] uppercase tracking-widest font-bold flex items-center gap-1.5 flex-wrap">
                      <span>{p.prop.statType}</span>
                      <span>·</span>
                      <span className="text-white/75">
                        {sideLabel} {p.prop.line}
                      </span>
                      {p.prop.oddsType !== "standard" && (
                        <>
                          <span>·</span>
                          <OddsBadge oddsType={p.prop.oddsType} />
                        </>
                      )}
                    </div>
                  </div>

                  {/* Side + probability */}
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px]"
                      style={{ backgroundColor: `${sideColor}20`, color: sideColor, border: `1px solid ${sideColor}` }}
                    >
                      <Icon size={11} strokeWidth={3} aria-hidden />
                      {sideLabel}
                    </span>
                    <span
                      className="font-[family-name:var(--font-display)] text-lg w-12 text-right"
                      style={{ color: sideColor }}
                    >
                      {(norm.probability * 100).toFixed(0)}%
                    </span>
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>

        {/* ── CTA ── */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            onClick={handleUse}
            className={cn(
              "group inline-flex items-center gap-2 px-6 py-3.5 rounded-full border-4 border-[#00F5D4] bg-gradient-to-r from-[#00F5D4] via-[#7B2FFF] to-[#FF3AF2]",
              "font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white",
              "hover:scale-[1.02] active:scale-[0.98] transition-transform",
              "focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FFE600] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D0D1A]",
            )}
          >
            Use this slip
            <ArrowRight size={18} strokeWidth={3} className="transition-transform group-hover:translate-x-1" aria-hidden />
          </button>
          <span className="text-white/45 text-[10px] uppercase tracking-widest font-bold">
            Skips the leaderboard · locks the slip in
          </span>
        </div>
      </div>
    </motion.section>
  );
}

/** Small stat tile used in the headline row. Internal-only. */
function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent: string;
}) {
  return (
    <div
      className="rounded-2xl border-2 px-3 py-3 md:px-4 md:py-4 bg-[#0D0D1A]/60"
      style={{ borderColor: `${accent}80` }}
    >
      <div
        className="text-[9px] md:text-[10px] uppercase tracking-widest font-bold mb-1"
        style={{ color: accent }}
      >
        {label}
      </div>
      {value}
      {sub && (
        <div className="text-white/50 text-[10px] mt-1.5 font-bold">{sub}</div>
      )}
    </div>
  );
}

/**
 * Compact pill button used in the size / play-type override rows. Active
 * pills fill with their accent color; disabled pills stay in flow but
 * are visibly muted and non-interactive.
 */
function PillToggle({
  active,
  disabled = false,
  onClick,
  label,
  icon,
  accent,
  hint,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  accent: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1 font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px] transition-all",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D0D1A]",
        active && "scale-105",
        disabled && "opacity-30 cursor-not-allowed",
        !disabled && !active && "hover:bg-white/5",
      )}
      style={{
        borderColor: disabled ? "rgba(255,255,255,0.15)" : accent,
        color: active ? "#0D0D1A" : disabled ? "rgba(255,255,255,0.4)" : accent,
        background: active ? accent : "transparent",
      }}
    >
      {icon}
      {label}
    </button>
  );
}
