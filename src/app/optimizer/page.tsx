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
} from "lucide-react";
import { useEffect } from "react";
import { useSelectionStore } from "@/stores/selectionStore";
import { useLineupStore } from "@/stores/lineupStore";
import { useProjectionStore } from "@/stores/projectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  optimize,
  POWER_MULTIPLIERS,
  applyCorrelationPenalty,
  correlationRisk,
  oddsPayoutFactor,
} from "@/lib/optimizer";
import { AnimatedPercent } from "@/components/AnimatedPercent";
import { OddsBadge } from "@/components/OddsBadge";
import { ProjectionBadge } from "@/components/ProjectionBadge";
import { SmartSuggest } from "@/components/SmartSuggest";
import { ProbabilityExplainer } from "@/components/ProbabilityExplainer";
import { accentHexFor, cn } from "@/lib/cn";
import type { PlayType, RiskMode } from "@/lib/types";

const LINEUP_SIZES = [2, 3, 4, 5, 6] as const;
const ENTRY_PRESETS = [5, 10, 20, 50, 100] as const;
const RISK_MODES: { id: RiskMode; label: string; icon: typeof Shield; desc: string }[] = [
  { id: "safe",       label: "Safe",       icon: Shield, desc: "Rank by highest hit %" },
  { id: "balanced",   label: "Balanced",   icon: Scale,  desc: "EV weighted by correlation" },
  { id: "aggressive", label: "Aggressive", icon: Flame,  desc: "Highest raw EV" },
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
  const setResults = useLineupStore((s) => s.setResults);

  const ballDontLieKey = useSettingsStore((s) => s.ballDontLieKey);
  const projByProp = useProjectionStore((s) => s.byProp);
  const fetchProjection = useProjectionStore((s) => s.fetchOne);

  const rawProps = useMemo(() => picks.map((p) => p.prop), [picks]);

  // Trigger real-projection fetch for every bench pick (MLB free; NBA needs key)
  useEffect(() => {
    rawProps.forEach((p) => fetchProjection(p, ballDontLieKey));
  }, [rawProps, ballDontLieKey, fetchProjection]);

  // Patch props with real projections when available
  const selectedProps = useMemo(
    () =>
      rawProps.map((p) => {
        const real = projByProp[p.id];
        if (real && real.available) {
          return { ...p, pMore: real.pMore, pLess: real.pLess, modelVersion: real.modelVersion };
        }
        return p;
      }),
    [rawProps, projByProp],
  );

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

  const [entry, setEntry] = useState<number>(20);
  const [playType, setPlayType] = useState<PlayType>("power");
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
      playType,
      entryCost: entry,
      riskMode: risk,
      maxResults: 50,
      filters,
    });
    setResults({
      ...result,
      params: { lineupSize: k, playType, entryCost: entry, riskMode: risk },
    });
    router.push("/slips");
  };

  // ── Empty cart state ──
  if (N === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-20 text-center relative">
        <div
          aria-hidden
          className="absolute -top-10 left-1/2 -translate-x-1/2 font-[family-name:var(--font-display)] text-[16rem] leading-none pointer-events-none select-none opacity-[0.06] text-[#FFE600]"
        >
          ?
        </div>
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="mx-auto w-24 h-24 rounded-3xl border-4 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 to-[#7B2FFF]/30 flex items-center justify-center mb-6"
          style={{ boxShadow: "5px 5px 0 #FF3AF2, 10px 10px 0 #00F5D4" }}
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
          Head back to the live board and tap MORE / LESS on the props you want to ride with.
        </p>
        <Link
          href="/live-board"
          className="inline-flex items-center gap-2 mt-8 px-8 py-4 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white hover:scale-105 active:scale-95 transition-transform"
        >
          To live board <ArrowRight strokeWidth={3} />
        </Link>
      </div>
    );
  }

  return (
    <div className="relative max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <div
        aria-hidden
        className="absolute -top-10 right-0 font-[family-name:var(--font-display)] text-[12rem] md:text-[18rem] leading-none pointer-events-none select-none opacity-[0.06] text-[#00F5D4]"
      >
        GO
      </div>

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
        % values are PrizePicks-implied (standard 50/50,{" "}
        <span className="text-[#FF6B35]">demon ~40%</span>,{" "}
        <span className="text-[#4ADE80]">goblin ~59%</span>) · payout factors stack
      </p>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 1 — YOUR SLIP (picks editor + live counter)
          ════════════════════════════════════════════════════════════════ */}
      <motion.div
        layout
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative rounded-3xl border-8 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/15 via-[#7B2FFF]/15 to-[#00F5D4]/15 backdrop-blur-sm overflow-hidden mb-10"
        style={{ boxShadow: "8px 8px 0 #FF3AF2, 16px 16px 0 #00F5D4" }}
      >
        {/* Pattern overlay */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-15"
          style={{
            backgroundImage: "radial-gradient(circle, #FFE600 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />

        <div className="relative grid lg:grid-cols-[1fr_400px] gap-0">
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
                  return (
                    <motion.div
                      key={pick.propId}
                      layout
                      initial={{ opacity: 0, x: -30 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -30 }}
                      transition={{ type: "spring", damping: 22 }}
                      className="relative rounded-2xl border-4 p-3 bg-[#0D0D1A]/60 backdrop-blur-sm flex items-center gap-3"
                      style={{ borderColor: accent, boxShadow: `3px 3px 0 ${accent2}` }}
                    >
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

                      {/* Player + stat */}
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
                      </div>

                      {/* MORE/LESS toggle */}
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
                      </div>

                      <button
                        onClick={() => remove(pick.propId)}
                        className="w-8 h-8 rounded-lg border-2 border-dashed border-white/30 text-white/50 hover:text-[#F87171] hover:border-[#F87171] transition-all flex items-center justify-center flex-shrink-0"
                        aria-label="Remove pick"
                      >
                        <XIcon size={14} strokeWidth={3} />
                      </button>
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

            {/* Payout panel */}
            <div className="mt-6 w-full max-w-[280px] grid grid-cols-2 gap-2">
              <div
                className="rounded-xl border-4 border-[#00F5D4] p-3 bg-[#0D0D1A]/40"
                title={`Power Play base ${baseMult}× × odds-type factor ${oddsFactor.toFixed(2)}× (demon ×1.25, goblin ×0.85 stacking)`}
              >
                <div className="text-[9px] uppercase tracking-widest font-bold text-white/60">Payout</div>
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
              >
                <div className="text-[9px] uppercase tracking-widest font-bold text-white/60">Expected value</div>
                <div
                  className="font-[family-name:var(--font-heading)] font-black text-3xl"
                  style={{ color: slipEv >= 0 ? "#4ADE80" : "#F87171" }}
                >
                  {slipEv >= 0 ? "+" : ""}${slipEv.toFixed(2)}
                </div>
              </div>
            </div>

            {/* Correlation badge */}
            <div className="mt-3">
              <span
                className="inline-flex items-center px-3 py-1 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase text-[10px] tracking-widest"
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
                {slipCorrRisk} correlation
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 2 — Smart suggest (recommendations across all sizes)
          ════════════════════════════════════════════════════════════════ */}
      <div className="mb-10">
        <SmartSuggest
          selectedProps={selectedProps}
          entryCost={entry}
          playType={playType}
          riskMode={risk}
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
          <ControlCard title="Lineup size" icon={Sliders} accent="#FF3AF2" accent2="#FFE600">
            <p className="text-white/60 text-xs mb-3">
              The optimizer generates all sub-combinations of this size from your {N} picks (over/under combos
              included).
            </p>
            <div className="flex flex-wrap gap-3">
              {LINEUP_SIZES.map((s) => (
                <button
                  key={s}
                  onClick={() => setSize(s)}
                  disabled={s > N}
                  className={cn(
                    "w-14 h-14 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black text-2xl transition-all",
                    s === size
                      ? "bg-[#FFE600] border-[#FF3AF2] text-[#0D0D1A] scale-110 shadow-[3px_3px_0_#FF3AF2]"
                      : s > N
                        ? "border-white/10 text-white/20 cursor-not-allowed"
                        : "border-[#FF3AF2] text-white hover:bg-[#FF3AF2]/20",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="text-white/60 text-xs mt-3">
              Power Play multiplier at size {k}:{" "}
              <span className="text-[#FFE600] font-black">{POWER_MULTIPLIERS[k] ?? 0}×</span>
            </p>
          </ControlCard>

          <ControlCard title="Play type" icon={Zap} accent="#00F5D4" accent2="#FF3AF2">
            <div className="grid grid-cols-2 gap-3">
              {(["power", "flex"] as const).map((pt) => (
                <button
                  key={pt}
                  onClick={() => setPlayType(pt)}
                  className={cn(
                    "h-14 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider transition-all",
                    pt === playType
                      ? "bg-[#00F5D4] border-[#FF3AF2] text-[#0D0D1A] scale-105 shadow-[3px_3px_0_#FF3AF2]"
                      : "border-[#00F5D4] text-white hover:bg-[#00F5D4]/20",
                  )}
                >
                  {pt === "power" ? "Power" : "Flex"}
                </button>
              ))}
            </div>
            <p className="text-white/60 text-xs mt-2">
              {playType === "power"
                ? "All picks must hit. Bigger payouts, no safety net."
                : "Partial hits still pay (e.g. 3/4 wins). Smaller multipliers."}
            </p>
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
                    Min EV ($)
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
                  aria-label="Minimum expected value in dollars"
                />
                <div className="text-[10px] text-white/40 font-bold mt-1">
                  ≥ $0 = only +EV slips · negative = allow risky bets
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
              key={`${N}-${k}-${playType}`}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="relative rounded-3xl border-4 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 via-[#7B2FFF]/30 to-[#00F5D4]/30 backdrop-blur-sm p-6"
              style={{ boxShadow: "5px 5px 0 #FF3AF2, 10px 10px 0 #00F5D4" }}
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
                "shadow-[4px_4px_0_#FFE600,8px_8px_0_#FF3AF2]",
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
              Default rank: hit % (Safe mode). Switch above to weigh by EV.
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
