"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight, TrendingUp, TrendingDown, Trophy, Target } from "lucide-react";
import { recommendLineups } from "@/lib/optimizer";
import { useLineupStore } from "@/stores/lineupStore";
import type { Prop, RiskMode } from "@/lib/types";
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

  // recommendLineups already does the cross-size search; we hard-code "safe"
  // (highest hit %) and pick the recommended lineup across all valid sizes.
  // It's pure / deterministic from inputs, so useMemo is appropriate.
  const best = useMemo(() => {
    if (selectedProps.length < 2) return null;
    const result = recommendLineups({
      selectedProps,
      entryCost,
      riskMode: "safe" as RiskMode,
      variantsByPropId,
      filters,
    });
    return result.recommended?.best ?? null;
  }, [selectedProps, entryCost, variantsByPropId, filters]);

  // Empty state — fewer than 2 picks means no lineup is possible. Render a
  // skeleton card with a hint so the section doesn't pop in/out as picks
  // are added.
  if (!best) {
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
        <p className="text-white/55 text-sm">
          Add 2 or more picks to your bench and we&apos;ll find the single lineup
          with the highest chance to hit.
        </p>
      </motion.section>
    );
  }

  const hitPct = best.hitProbability * 100;
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
              We crunched every combination of your {selectedProps.length} picks across every variant ladder. This
              <span className="text-[#00F5D4] font-bold"> {best.picks.length}-pick {best.playType} slip </span>
              has the highest chance to hit.
            </p>
          </div>
        </div>
      </div>

      {/* ── Headline stats row ── */}
      <div className="grid grid-cols-3 gap-3 md:gap-4 p-6 md:p-8 border-b-4 border-dashed border-[#00F5D4]/40">
        <Stat
          label="Hit %"
          value={
            <span style={{ color: pctColor }} className="block">
              <AnimatedPercent value={hitPct} className="font-[family-name:var(--font-display)] text-4xl md:text-6xl leading-none" />
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
              const isMore = p.side === "more";
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
                      {(p.probability * 100).toFixed(0)}%
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
