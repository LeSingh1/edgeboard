"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Zap,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  Sliders,
  Shield,
  Scale,
  Flame,
  X as XIcon,
  ShoppingCart,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import { useEffect } from "react";
import { useSelectionStore } from "@/stores/selectionStore";
import { useLineupStore } from "@/stores/lineupStore";
import { useProjectionStore } from "@/stores/projectionStore";
import { useIntelStore } from "@/stores/intelStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  optimize,
  POWER_MULTIPLIERS,
  applyCorrelationPenalty,
  correlationRisk,
  detectReversion,
  oddsPayoutFactor,
  meetsTeamDiversity,
} from "@/lib/optimizer";
import { AnimatedPercent } from "@/components/AnimatedPercent";
import { OddsBadge } from "@/components/OddsBadge";
import { ProjectionBadge } from "@/components/ProjectionBadge";
import { SmartSuggest } from "@/components/SmartSuggest";
import { BestSingleSlip } from "@/components/BestSingleSlip";
import { ProbabilityExplainer } from "@/components/ProbabilityExplainer";
import { VariantTabs } from "@/components/VariantTabs";
import { MatchupIntel } from "@/components/MatchupIntel";
import { variantCount, type VariantSet } from "@/lib/variantGroups";
import { accentHexFor, cn } from "@/lib/cn";
import type { RiskMode, Prop } from "@/lib/types";

const ENTRY_PRESETS = [5, 10, 20, 50, 100] as const;
const RISK_MODES: { id: RiskMode; label: string; icon: typeof Shield; desc: string }[] = [
  { id: "safe",       label: "Safe",       icon: Shield, desc: "Highest chance of hitting" },
  { id: "balanced",   label: "Balanced",   icon: Scale,  desc: "Best avg $ (same-game picks penalized)" },
  { id: "aggressive", label: "Aggressive", icon: Flame,  desc: "Highest avg $ per play" },
];

function nCk(n: number, k: number): number {
  if (k > n || k < 0) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

export default function OptimizerPage() {
  const router = useRouter();
  const picks = useSelectionStore((s) => s.picks);
  const remove = useSelectionStore((s) => s.remove);
  const toggle = useSelectionStore((s) => s.toggle);
  const swapVariant = useSelectionStore((s) => s.swapVariant);
  const setResults = useLineupStore((s) => s.setResults);

  const ballDontLieKey = useSettingsStore((s) => s.ballDontLieKey);
  const anthropicKey = useSettingsStore((s) => s.anthropicKey);
  const projByProp = useProjectionStore((s) => s.byProp);
  const fetchProjection = useProjectionStore((s) => s.fetchOne);
  const intelByProp = useIntelStore((s) => s.byProp);
  const fetchIntel = useIntelStore((s) => s.fetchOne);

  // Trigger real-projection fetch for every bench pick AND its sibling variants
  // (goblin / standard / demon). The optimizer might swap variants when generating
  // lineups, so we need a real pMore for each line — a goblin line has a much
  // higher pMore than the standard line, even from the same player gamelog.
  useEffect(() => {
    for (const pk of picks) {
      fetchProjection(pk.prop, ballDontLieKey);
      if (pk.variants?.goblin && pk.variants.goblin.id !== pk.propId)
        fetchProjection(pk.variants.goblin, ballDontLieKey);
      if (pk.variants?.standard && pk.variants.standard.id !== pk.propId)
        fetchProjection(pk.variants.standard, ballDontLieKey);
      if (pk.variants?.demon && pk.variants.demon.id !== pk.propId)
        fetchProjection(pk.variants.demon, ballDontLieKey);
    }
  }, [picks, ballDontLieKey, fetchProjection]);

  // Trigger matchup-intel fetch (ESPN news + heuristic + optional Claude) for
  // each bench pick. Only the user's active variant — intel is family-level
  // (player, opponent), not variant-specific, so one fetch per family.
  useEffect(() => {
    for (const pk of picks) {
      fetchIntel(pk.prop, anthropicKey);
    }
  }, [picks, anthropicKey, fetchIntel]);

  // Patch a Prop with real projection data + intel swing (when available).
  // Intel is family-level (player + opponent), so all variants in a family
  // share the same swing — caller passes the swing in explicitly.
  const patchProp = (p: Prop, intelSwing = 0): Prop => {
    const real = projByProp[p.id];
    let patched = p;
    if (real && real.available) {
      patched = { ...patched, pMore: real.pMore, pLess: real.pLess, modelVersion: real.modelVersion };
    }
    if (Math.abs(intelSwing) > 0.005) {
      const newMore = Math.max(0.02, Math.min(0.98, patched.pMore + intelSwing));
      patched = { ...patched, pMore: newMore, pLess: 1 - newMore };
    }
    return patched;
  };

  // Patch user's selected variant for live counter + optimizer baseline.
  // Applies the family-level intel swing on top of the real projection.
  const selectedProps = useMemo(
    () =>
      picks.map((pk) => {
        const swing = intelByProp[pk.propId]?.combinedSwing ?? 0;
        return patchProp(pk.prop, swing);
      }),
    [picks, projByProp, intelByProp], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Patch each variant — real projections per-variant, intel swing shared from
  // the parent pick (intel is player+opponent-level, not line-level).
  const variantsByPropId = useMemo(() => {
    const map: Record<string, VariantSet> = {};
    for (const pk of picks) {
      if (!pk.variants) continue;
      const swing = intelByProp[pk.propId]?.combinedSwing ?? 0;
      const patched: VariantSet = {};
      if (pk.variants.goblin) patched.goblin = patchProp(pk.variants.goblin, swing);
      if (pk.variants.standard) patched.standard = patchProp(pk.variants.standard, swing);
      if (pk.variants.demon) patched.demon = patchProp(pk.variants.demon, swing);
      map[pk.propId] = patched;
    }
    return map;
  }, [picks, projByProp, intelByProp]); // eslint-disable-line react-hooks/exhaustive-deps

  const N = selectedProps.length;
  const slipSize = Math.min(Math.max(N, 2), 6);

  // ── Live slip math (uses real projections when available, implied otherwise)
  const slipHitProb = useMemo(() => {
    if (N === 0) return 0;
    const probs = picks.map((p, i) => {
      const patched = selectedProps[i] ?? p.prop;
      return p.side === "more" ? patched.pMore : patched.pLess;
    });
    const pIndependent = probs.reduce((a, b) => a * b, 1);
    return applyCorrelationPenalty(pIndependent, selectedProps);
  }, [picks, selectedProps, N]);
  const slipCorrRisk = useMemo(() => correlationRisk(selectedProps), [selectedProps]);
  const reversion = useMemo(() => detectReversion(selectedProps), [selectedProps]);

  const [entry, setEntry] = useState<number>(20);
  const [risk, setRisk] = useState<RiskMode>("balanced");
  const [size, setSize] = useState<number>(slipSize);
  const [running, setRunning] = useState(false);
  // ── Filters ──
  const [minHitPct, setMinHitPct] = useState<number>(0);   // 0..50 percent
  const [minEv, setMinEv] = useState<number>(-50);          // -50..+50 dollars
  const filters = useMemo(
    () => ({ minHitProb: minHitPct / 100, minEv }),
    [minHitPct, minEv],
  );

  // Keep lineup size in valid range when bench changes (effect, NOT memo).
  // Deferred via microtask to avoid the cascade-render lint warning — the
  // size update is a normalization, not a derived value.
  useEffect(() => {
    if (N > 0 && (size > N || size < 2)) {
      queueMicrotask(() => setSize(Math.min(Math.max(N, 2), 6)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [N]);

  const k = Math.min(size, N);
  const totalLineups = N >= k && k >= 2 ? nCk(N, k) * (1 << k) : 0;

  const baseMult = POWER_MULTIPLIERS[Math.min(Math.max(N, 2), 6)] ?? 0;
  const oddsFactor = useMemo(() => oddsPayoutFactor(selectedProps), [selectedProps]);
  const slipMultiplier = baseMult * oddsFactor;
  const slipPayout = entry * slipMultiplier;
  const slipEv = slipHitProb * slipPayout - entry;

  // Color cue for the live %
  const pctColor =
    slipHitProb >= 0.25
      ? "#4ADE80"
      : slipHitProb >= 0.10
        ? "#FFE600"
        : "#F87171";

  const handleRun = async () => {
    if (totalLineups === 0) return;
    setRunning(true);
    await new Promise((r) => setTimeout(r, 250));
    const result = optimize({
      selectedProps,
      lineupSize: k,
      entryCost: entry,
      riskMode: risk,
      maxResults: 50,
      variantsByPropId,
      filters,
    });
    setResults({
      ...result,
      // playType is per-lineup now — store "mixed" sentinel for the params header.
      // The leaderboard reads playType from each individual lineup.
      params: { lineupSize: k, playType: "power", entryCost: entry, riskMode: risk },
    });
    router.push("/slips");
  };

  // ── Empty cart state ──
  if (N === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-center">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="mx-auto w-24 h-24 rounded-3xl border-4 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 to-[#7B2FFF]/30 flex items-center justify-center mb-6"
        >
          <ShoppingCart size={42} strokeWidth={3} className="text-[#FFE600]" />
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="font-[family-name:var(--font-heading)] font-black text-6xl uppercase tracking-tighter gradient-text-rainbow"
        >
          Cart is empty
        </motion.h1>
        <p className="text-white/70 text-lg mt-6">
          Head back to the live board and tap MORE / LESS on the props you want to ride with —
          or let Auto-Pilot pick the best ones for you.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
          <Link
            href="/auto-pilot"
            className="inline-flex items-center gap-2 px-8 py-4 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white hover:scale-105 active:scale-95 transition-transform"
          >
            <Sparkles size={18} strokeWidth={3} />
            Build me lineups
          </Link>
          <Link
            href="/live-board"
            className="inline-flex items-center gap-2 px-6 py-4 rounded-full border-4 border-dashed border-white/30 text-white/80 font-[family-name:var(--font-heading)] font-black uppercase tracking-widest hover:bg-white/5 transition-colors"
          >
            To live board <ArrowRight strokeWidth={3} />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <motion.h1
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow mb-3"
      >
        Optimize
      </motion.h1>
      <p className="text-white/70 text-lg mb-2 max-w-2xl">
        Toggle More / Less on each pick to tune your slip — the hit-probability counter updates live.
        When you&apos;re ready, generate every alternative combination ranked by chance of hitting.
      </p>
      <p className="text-white/40 text-xs mb-10 max-w-2xl uppercase tracking-widest font-bold">
        Picks with an <span className="text-[#4ADE80]">Edge</span> badge show % from the player&apos;s game log ·
        picks without a badge use PrizePicks line data only
      </p>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 1 — YOUR SLIP (picks editor + live counter)
          ════════════════════════════════════════════════════════════════ */}
      <motion.div
        layout
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-3xl border-8 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/15 via-[#7B2FFF]/15 to-[#00F5D4]/15 backdrop-blur-sm overflow-hidden mb-10"
      >
        <div className="grid lg:grid-cols-[1fr_400px] gap-0">
          {/* ── LEFT: editable picks ── */}
          <div className="p-6 md:p-8 lg:border-r-4 lg:border-dashed lg:border-[#FFE600]/40">
            <div className="flex items-center gap-2 mb-4">
              <ShoppingCart size={20} strokeWidth={3} className="text-[#FFE600]" />
              <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm text-[#FFE600]">
                Your slip · {N} picks
              </h2>
            </div>

            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {picks.map((pick, i) => {
                  const accent = accentHexFor(i);
                  const accent2 = accentHexFor(i + 2);
                  const isMore = pick.side === "more";
                  // Use real-projection-patched probability if available, fall back to implied
                  const patched = selectedProps[i] ?? pick.prop;
                  const pMore = patched.pMore * 100;
                  const pLess = patched.pLess * 100;
                  // Narrow projection result so we can pull adjustments + baseline for MatchupIntel
                  const projRaw = projByProp[pick.propId];
                  const projAvail = projRaw && projRaw.available ? projRaw : null;
                  const baselineForSide =
                    projAvail?.baselinePMore !== undefined
                      ? pick.side === "more"
                        ? projAvail.baselinePMore
                        : 1 - projAvail.baselinePMore
                      : undefined;
                  return (
                    <motion.div
                      key={pick.propId}
                      layout
                      initial={{ opacity: 0, x: -30 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -30 }}
                      transition={{ type: "spring", damping: 22 }}
                      className="relative rounded-2xl border-4 p-3 bg-[#0D0D1A]/60 backdrop-blur-sm"
                      style={{ borderColor: accent, boxShadow: `3px 3px 0 ${accent2}` }}
                    >
                      <div className="flex items-center gap-3">
                      {/* Headshot */}
                      <div
                        className="w-14 h-14 rounded-full border-2 overflow-hidden flex-shrink-0 bg-[#0D0D1A] flex items-center justify-center"
                        style={{ borderColor: accent }}
                      >
                        {pick.prop.playerImage ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={pick.prop.playerImage}
                            alt={pick.prop.playerName}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="font-[family-name:var(--font-heading)] font-black text-xs">
                            {pick.prop.playerName.slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>

                      {/* Player + stat + variant swap */}
                      <div className="flex-1 min-w-0 mr-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="font-[family-name:var(--font-heading)] font-black uppercase text-sm truncate">
                            {pick.prop.playerName}
                          </div>
                          <OddsBadge oddsType={pick.prop.oddsType} compact />
                          <ProjectionBadge propId={pick.propId} />
                        </div>
                        <div className="text-white/60 text-xs truncate">
                          <span className="text-[#FFE600] font-bold">{pick.prop.line}</span>{" "}
                          {pick.prop.statType}
                          {pick.prop.sport ? <span className="opacity-60"> · {pick.prop.sport}</span> : null}
                        </div>
                        {/* Variant ladder row — shows every rung the user could swap to */}
                        {pick.variants && variantCount(pick.variants) > 1 && (
                          <div className="mt-1.5">
                            <VariantTabs
                              variants={pick.variants}
                              activePropId={pick.propId}
                              compact
                              onChange={(newProp) =>
                                swapVariant(pick.propId, newProp, pick.variants)
                              }
                            />
                          </div>
                        )}
                      </div>

                      {/* MORE/LESS toggle — LESS hidden for demon/goblin (MORE only) */}
                      <div className="flex gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => toggle(pick.prop, "more")}
                          className={cn(
                            "px-3 py-2 rounded-lg border-2 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-wider transition-all flex flex-col items-center justify-center gap-0",
                            isMore
                              ? "bg-[#4ADE80] border-[#FFE600] text-[#0D0D1A] shadow-[2px_2px_0_#0D0D1A]"
                              : "border-[#4ADE80]/60 text-[#4ADE80]/70 hover:bg-[#4ADE80]/15 hover:border-[#4ADE80]",
                          )}
                        >
                          <div className="flex items-center gap-1 text-[11px]">
                            <TrendingUp size={11} strokeWidth={3} />
                            More
                          </div>
                          <span className="text-[9px] opacity-80">{pMore.toFixed(0)}%</span>
                        </button>
                        {pick.prop.oddsType === "standard" ? (
                          <button
                            onClick={() => toggle(pick.prop, "less")}
                            className={cn(
                              "px-3 py-2 rounded-lg border-2 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-wider transition-all flex flex-col items-center justify-center gap-0",
                              !isMore
                                ? "bg-[#F87171] border-[#FFE600] text-[#0D0D1A] shadow-[2px_2px_0_#0D0D1A]"
                                : "border-[#F87171]/60 text-[#F87171]/70 hover:bg-[#F87171]/15 hover:border-[#F87171]",
                            )}
                          >
                            <div className="flex items-center gap-1 text-[11px]">
                              <TrendingDown size={11} strokeWidth={3} />
                              Less
                            </div>
                            <span className="text-[9px] opacity-80">{pLess.toFixed(0)}%</span>
                          </button>
                        ) : (
                          <span
                            title={`${pick.prop.oddsType === "demon" ? "Demon" : "Goblin"} — MORE only on PrizePicks`}
                            className="px-2 py-2 rounded-lg border-2 border-dashed border-white/15 text-white/30 text-[9px] font-bold uppercase tracking-widest flex items-center justify-center"
                          >
                            More only
                          </span>
                        )}
                      </div>

                      <button
                        onClick={() => remove(pick.propId)}
                        className="w-8 h-8 rounded-lg border-2 border-dashed border-white/30 text-white/50 hover:text-[#F87171] hover:border-[#F87171] transition-all flex items-center justify-center flex-shrink-0"
                        aria-label="Remove pick"
                      >
                        <XIcon size={14} strokeWidth={3} />
                      </button>
                      </div>

                      {/* Matchup intel — expandable AI grade explainer */}
                      <MatchupIntel
                        intel={intelByProp[pick.propId]}
                        adjustments={projAvail?.adjustments}
                        finalPMore={pick.side === "more" ? patched.pMore : patched.pLess}
                        baselinePMore={baselineForSide}
                      />
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>

          {/* ── RIGHT: hit-probability counter ── */}
          <div className="relative p-6 md:p-8 flex flex-col items-center justify-center text-center">
            <div className="text-[#FFE600] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-xs mb-2">
              Hit Probability
            </div>

            <motion.div
              key={pctColor}
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", damping: 14, stiffness: 220 }}
              className="font-[family-name:var(--font-display)] leading-none"
              style={{
                color: pctColor,
                fontSize: "6rem",
                textShadow: `2px 2px 0 #7B2FFF, 4px 4px 0 #FF3AF2`,
              }}
            >
              <AnimatedPercent value={slipHitProb} decimals={1} />
            </motion.div>

            <div className="mt-4 text-white/70 text-sm">
              if all {N} picks land as configured
            </div>

            {/* Explainer: how this number was calculated */}
            <ProbabilityExplainer
              picks={picks.map((p) => ({
                prop: p.prop,
                side: p.side,
                probability: p.side === "more" ? p.prop.pMore : p.prop.pLess,
              }))}
              finalHitProb={slipHitProb}
            />

            {/* Reversion lineup warning — fires when every (or most) picks are
                from the same game. PrizePicks reduces their payout for these
                slips (the "Reversion lineup payouts are different" banner the
                user sees in the actual app). Our estimate doesn't apply that
                same discount, so a full reversion will pay ~5-10% less in
                reality than the "Payout (est.)" box shows. */}
            {reversion.level !== "none" && (
              <div
                className={cn(
                  "mt-4 w-full max-w-[280px] rounded-xl border-2 border-dashed px-3 py-2 text-left",
                  reversion.level === "full"
                    ? "border-[#FF6B35] bg-[#FF6B35]/10"
                    : "border-[#FFE600] bg-[#FFE600]/10",
                )}
                title={
                  reversion.level === "full"
                    ? "All your picks are in the same game. PrizePicks tags this a 'reversion lineup' and applies a reduced multiplier — expect to be paid ~5–10% less than the estimated payout."
                    : `${reversion.sharedCount} of ${reversion.totalPicks} picks share a game. PrizePicks may apply a partial reversion discount on the payout.`
                }
              >
                <div
                  className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px]"
                  style={{ color: reversion.level === "full" ? "#FF6B35" : "#FFE600" }}
                >
                  ⚠ {reversion.level === "full" ? "Reversion lineup" : "Partial reversion"}
                </div>
                <div className="text-white/70 text-[10px] leading-snug mt-1">
                  {reversion.level === "full" ? (
                    <>
                      All {reversion.totalPicks} picks share one game. PrizePicks pays{" "}
                      <strong className="text-[#FF6B35]">~5–10% less</strong> on these slips than the
                      estimate below.
                    </>
                  ) : (
                    <>
                      {reversion.sharedCount} of {reversion.totalPicks} picks share a game.
                      PrizePicks may apply a partial discount.
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Payout panel */}
            <div className="mt-6 w-full max-w-[280px] grid grid-cols-2 gap-2">
              <div
                className="rounded-xl border-4 border-[#00F5D4] p-3 bg-[#0D0D1A]/40"
                title={`Power Play base ${baseMult}× × odds-type factor ${oddsFactor.toFixed(2)}× (demon ×1.5, goblin ×0.85 stacking). PrizePicks computes their own multiplier per slip — actual payout can vary slightly with how deep your demon/goblin lines are from standard. Verify on the PrizePicks app before entering.`}
              >
                <div className="text-[9px] uppercase tracking-widest font-bold text-white/60">Payout (est.)</div>
                <div className="font-[family-name:var(--font-heading)] font-black text-2xl text-[#00F5D4]">
                  {slipMultiplier.toFixed(2)}×
                </div>
                {oddsFactor !== 1 && (
                  <div className="text-[8px] text-white/50 font-bold tracking-widest mt-0.5">
                    {baseMult}× base × {oddsFactor.toFixed(2)}
                  </div>
                )}
              </div>
              <div className="rounded-xl border-4 border-[#FF3AF2] p-3 bg-[#0D0D1A]/40">
                <div className="text-[9px] uppercase tracking-widest font-bold text-white/60">If hit</div>
                <div className="font-[family-name:var(--font-heading)] font-black text-2xl text-[#FF3AF2]">
                  ${slipPayout.toFixed(0)}
                </div>
              </div>
              <div
                className="rounded-xl border-4 p-3 bg-[#0D0D1A]/40 col-span-2"
                style={{
                  borderColor: slipEv >= 0 ? "#4ADE80" : "#F87171",
                }}
                title="Average dollars you'd make per play if you ran this exact slip many times. Positive = makes money long-term, negative = loses long-term."
              >
                <div className="text-[9px] uppercase tracking-widest font-bold text-white/60">
                  Avg $ per play
                </div>
                <div
                  className="font-[family-name:var(--font-heading)] font-black text-3xl"
                  style={{ color: slipEv >= 0 ? "#4ADE80" : "#F87171" }}
                >
                  {slipEv >= 0 ? "+" : ""}${slipEv.toFixed(2)}
                </div>
                <div className="text-[8px] text-white/50 font-bold tracking-widest mt-0.5">
                  {slipEv >= 0 ? "profitable long-term" : "loses long-term"}
                </div>
              </div>
            </div>

            {/* Overlap badge — same-game / same-player picks are correlated,
                so when one wins the others are more likely to too. Higher overlap =
                lumpier results (bigger wins, bigger zeros). */}
            <div className="mt-3">
              <span
                title={
                  slipCorrRisk === "low"
                    ? "Your picks are from different games and players — outcomes are independent."
                    : slipCorrRisk === "medium"
                      ? "Some picks share a game or player. Outcomes are partially linked."
                      : "Many picks share games or players. Results will be lumpy — big wins or big zeros, not balanced."
                }
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase text-[10px] tracking-widest"
                style={{
                  borderColor:
                    slipCorrRisk === "high"
                      ? "#F87171"
                      : slipCorrRisk === "medium"
                        ? "#FFE600"
                        : "#4ADE80",
                  color:
                    slipCorrRisk === "high"
                      ? "#F87171"
                      : slipCorrRisk === "medium"
                        ? "#FFE600"
                        : "#4ADE80",
                  background: `${
                    slipCorrRisk === "high"
                      ? "rgba(248,113,113,0.1)"
                      : slipCorrRisk === "medium"
                        ? "rgba(255,230,0,0.1)"
                        : "rgba(74,222,128,0.1)"
                  }`,
                }}
              >
                <span
                  aria-hidden
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{
                    background:
                      slipCorrRisk === "high"
                        ? "#F87171"
                        : slipCorrRisk === "medium"
                          ? "#FFE600"
                          : "#4ADE80",
                  }}
                />
                {slipCorrRisk === "low" ? "Picks independent" : slipCorrRisk === "medium" ? "Some overlap" : "Lots of overlap"}
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* PrizePicks rule warning — when the entire bench is one team, PP
          will reject the lineup at entry. Surface this loudly so the user
          doesn't waste a "Generate" run that returns nothing. */}
      {N >= 2 && !meetsTeamDiversity(selectedProps) && (
        <motion.div
          layout
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border-4 border-[#F87171] bg-[#F87171]/10 p-4 md:p-5 mb-10 flex items-start gap-3"
          role="alert"
        >
          <AlertTriangle size={22} strokeWidth={3} className="text-[#F87171] flex-shrink-0 mt-0.5" aria-hidden />
          <div>
            <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm text-[#F87171]">
              PrizePicks won&apos;t accept this slip
            </div>
            <p className="text-white/75 text-sm mt-1">
              Every PP lineup needs players from at least 2 different teams. All
              of your bench picks are on the same team right now — add one from
              another team to make it enterable.
            </p>
          </div>
        </motion.div>
      )}

      {/* ════════════════════════════════════════════════════════════════
          SECTION 1.5 — ONE BEST SLIP
          Collapse the search to a single answer: "which lineup has the
          highest chance to hit if I'm only playing one tonight?"
          Hard-coded to "safe" mode regardless of the multi-lineup risk
          setting so this section's answer is unambiguous.
          ════════════════════════════════════════════════════════════════ */}
      <BestSingleSlip
        selectedProps={selectedProps}
        entryCost={entry}
        variantsByPropId={variantsByPropId}
        filters={filters}
      />

      {/* ════════════════════════════════════════════════════════════════
          SECTION 2 — Smart suggest (recommendations across all sizes)
          ════════════════════════════════════════════════════════════════ */}
      <div className="mb-10">
        <SmartSuggest
          selectedProps={selectedProps}
          entryCost={entry}
          riskMode={risk}
          variantsByPropId={variantsByPropId}
          filters={filters}
          currentSize={size}
          onApply={(s) => setSize(s)}
        />
      </div>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 3 — Lineup configuration + Generate
          ════════════════════════════════════════════════════════════════ */}
      <div className="grid lg:grid-cols-[1fr_360px] gap-8">
        <div className="space-y-5">
          <ControlCard title="Play type" icon={Zap} accent="#00F5D4" accent2="#FF3AF2">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl border-4 border-[#00F5D4] bg-[#00F5D4]/10 flex items-center justify-center flex-shrink-0">
                <Sparkles className="text-[#00F5D4]" size={18} strokeWidth={3} />
              </div>
              <div>
                <div className="font-[family-name:var(--font-heading)] font-black uppercase text-sm text-[#00F5D4]">
                  Auto-picked per lineup
                </div>
                <p className="text-white/60 text-xs mt-1">
                  The optimizer generates BOTH Power and Flex versions of every lineup shape and
                  surfaces whichever has the better long-run average dollars. Your leaderboard will show a
                  mix tagged with the play type that won — more variety, less guesswork.
                </p>
              </div>
            </div>
          </ControlCard>

          <ControlCard title="Entry cost" icon={TrendingUp} accent="#FFE600" accent2="#7B2FFF">
            <div className="flex flex-wrap gap-3">
              {ENTRY_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setEntry(p)}
                  className={cn(
                    "px-5 h-12 rounded-full border-4 font-[family-name:var(--font-heading)] font-black text-lg transition-all",
                    p === entry
                      ? "bg-[#7B2FFF] border-[#FFE600] text-white shadow-[2px_2px_0_#FFE600]"
                      : "border-[#7B2FFF] text-white hover:bg-[#7B2FFF]/20",
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

          <ControlCard title="Rank by" icon={Flame} accent="#FF6B35" accent2="#00F5D4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {RISK_MODES.map((r) => {
                const active = r.id === risk;
                const Icon = r.icon;
                return (
                  <button
                    key={r.id}
                    onClick={() => setRisk(r.id)}
                    className={cn(
                      "relative rounded-2xl border-4 p-3 text-left transition-all",
                      active
                        ? "border-[#FFE600] bg-gradient-to-br from-[#FF6B35]/30 to-[#7B2FFF]/30 shadow-[2px_2px_0_#FFE600]"
                        : "border-[#FF6B35] hover:bg-[#FF6B35]/15",
                    )}
                  >
                    <Icon size={20} strokeWidth={3} className={active ? "text-[#FFE600]" : "text-[#FF6B35]"} />
                    <div className="font-[family-name:var(--font-heading)] font-black uppercase text-sm mt-1.5">
                      {r.label}
                    </div>
                    <div className="text-white/60 text-[10px] mt-0.5">{r.desc}</div>
                  </button>
                );
              })}
            </div>
          </ControlCard>

          {/* Filters */}
          <ControlCard title="Filters" icon={Sliders} accent="#7B2FFF" accent2="#FFE600">
            <p className="text-white/60 text-xs mb-3">
              Only keep lineups that clear these thresholds (also drives Smart Suggest above).
            </p>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-[#7B2FFF]">
                    Min hit %
                  </label>
                  <span className="font-[family-name:var(--font-display)] text-xl text-[#FFE600] leading-none">
                    {minHitPct}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={minHitPct}
                  onChange={(e) => setMinHitPct(Number(e.target.value))}
                  className="w-full accent-[#7B2FFF]"
                  aria-label="Minimum hit probability"
                />
                <div className="text-[10px] text-white/40 font-bold mt-1">
                  0% = include everything · 25%+ = aggressive cutoff
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-[#7B2FFF]">
                    Min avg $ per play
                  </label>
                  <span
                    className="font-[family-name:var(--font-display)] text-xl leading-none"
                    style={{ color: minEv >= 0 ? "#4ADE80" : "#F87171" }}
                  >
                    {minEv >= 0 ? "+" : ""}${minEv}
                  </span>
                </div>
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={1}
                  value={minEv}
                  onChange={(e) => setMinEv(Number(e.target.value))}
                  className="w-full accent-[#7B2FFF]"
                  aria-label="Minimum average dollars per play"
                />
                <div className="text-[10px] text-white/40 font-bold mt-1">
                  ≥ $0 = only slips that make money long-term · negative = allow losing-bet slips
                </div>
              </div>
              {(minHitPct > 0 || minEv > -50) && (
                <button
                  onClick={() => {
                    setMinHitPct(0);
                    setMinEv(-50);
                  }}
                  className="text-xs text-white/50 hover:text-white uppercase tracking-widest font-bold transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
          </ControlCard>
        </div>

        {/* Sticky summary + generate */}
        <aside>
          <div className="sticky top-24 space-y-4">
            <motion.div
              key={`${N}-${k}`}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="rounded-3xl border-4 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 via-[#7B2FFF]/30 to-[#00F5D4]/30 backdrop-blur-sm p-6"
            >
              <div className="text-white/70 text-[10px] uppercase tracking-widest font-bold">
                Alternatives the optimizer will rank
              </div>
              <div className="font-[family-name:var(--font-display)] text-6xl text-[#FFE600] leading-none mt-1 text-shadow-2">
                {totalLineups.toLocaleString()}
              </div>
              <div className="text-white/70 text-xs mt-2">
                lineups · C({N}, {k}) × 2<sup>{k}</sup>
              </div>
            </motion.div>

            <button
              onClick={handleRun}
              disabled={running || totalLineups === 0}
              className={cn(
                "w-full h-16 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4]",
                "font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-lg",
                "flex items-center justify-center gap-3 transition-all",
                "hover:scale-105 active:scale-95",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
                !running && totalLineups > 0 && "animate-(--animate-pulse-glow)",
              )}
            >
              {running ? (
                <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                  <Sliders size={22} strokeWidth={3} />
                </motion.span>
              ) : (
                <Zap size={22} strokeWidth={3} />
              )}
              {running ? "Crunching..." : "Generate leaderboard"}
            </button>

            <p className="text-center text-white/50 text-xs">
              Default rank: chance of hitting (Safe). Switch above to weigh by avg $ per play.
            </p>
          </div>
        </aside>
      </div>
    </div>
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
