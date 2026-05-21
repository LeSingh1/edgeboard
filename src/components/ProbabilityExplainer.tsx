"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Info, ChevronDown } from "lucide-react";
import { useState } from "react";
import { correlationRisk } from "@/lib/optimizer";
import { OddsBadge } from "@/components/OddsBadge";
import type { Prop, PickSide } from "@/lib/types";

interface ProbabilityExplainerProps {
  picks: { prop: Prop; side: PickSide; probability: number }[];
  finalHitProb: number;
}

const RHO = { low: 0, medium: 0.20, high: 0.45 };

export function ProbabilityExplainer({ picks, finalHitProb }: ProbabilityExplainerProps) {
  const [open, setOpen] = useState(false);
  if (picks.length === 0) return null;

  const pRaw = picks.reduce((a, p) => a * p.probability, 1);
  const risk = correlationRisk(picks.map((p) => p.prop));
  const rho = RHO[risk];
  const k = picks.length;
  const totalPairs = (k * (k - 1)) / 2;
  let correlatedPairs = 0;
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i].prop, b = picks[j].prop;
      const sameGame =
        `${a.team}-${a.opponent}-${a.gameTime}` ===
        `${b.team}-${b.opponent}-${b.gameTime}`;
      if (a.playerName === b.playerName || sameGame) correlatedPairs++;
    }
  }
  const penaltyFactor = rho === 0 || totalPairs === 0 ? 1 : 1 - rho * (correlatedPairs / totalPairs);

  return (
    <div className="mt-4 w-full max-w-[320px] mx-auto">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-center gap-1.5 text-white/60 hover:text-[#00F5D4] text-[10px] uppercase tracking-widest font-bold transition-colors py-1 focus:outline-none focus:text-[#00F5D4]"
        aria-expanded={open}
      >
        <Info size={12} strokeWidth={3} />
        How we got this number
        <ChevronDown
          size={12}
          strokeWidth={3}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="mt-2 rounded-xl border-2 border-dashed border-[#00F5D4]/40 bg-[#0D0D1A]/60 p-3 text-left text-[11px] leading-relaxed">
              <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#00F5D4] text-[10px] mb-2">
                Step 1 · Per-pick implied probability
              </div>
              <div className="space-y-1.5 font-[family-name:ui-monospace,SFMono-Regular,Menlo,monospace]">
                {picks.map((p, i) => {
                  const isMore = p.side === "more";
                  return (
                    <div key={i} className="flex items-center justify-between gap-2 text-[10px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`w-4 h-4 rounded border flex items-center justify-center text-[9px] font-black ${isMore ? "border-[#4ADE80] text-[#4ADE80]" : "border-[#F87171] text-[#F87171]"}`}
                        >
                          {isMore ? "▲" : "▼"}
                        </span>
                        <span className="text-white/80 truncate">{p.prop.playerName}</span>
                        <OddsBadge oddsType={p.prop.oddsType} compact />
                      </div>
                      <span className="text-[#FFE600] font-bold">
                        {(p.probability * 100).toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="border-t-2 border-dashed border-white/10 mt-3 pt-3">
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#00F5D4] text-[10px] mb-1">
                  Step 2 · Multiply (independent)
                </div>
                <div className="text-white/70 font-[family-name:ui-monospace,SFMono-Regular,Menlo,monospace] text-[10px]">
                  {picks.map((p) => (p.probability * 100).toFixed(1) + "%").join(" × ")}{" "}
                  ={" "}
                  <span className="text-[#FFE600] font-bold">{(pRaw * 100).toFixed(2)}%</span>
                </div>
              </div>

              <div className="border-t-2 border-dashed border-white/10 mt-3 pt-3">
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#00F5D4] text-[10px] mb-1">
                  Step 3 · Correlation penalty
                </div>
                <div className="text-white/70 text-[10px] space-y-1">
                  <div>
                    Risk: <span className="font-bold uppercase" style={{
                      color: risk === "high" ? "#F87171" : risk === "medium" ? "#FFE600" : "#4ADE80",
                    }}>{risk}</span> (ρ = {rho.toFixed(2)})
                  </div>
                  <div className="font-[family-name:ui-monospace,SFMono-Regular,Menlo,monospace]">
                    {correlatedPairs} of {totalPairs} pairs correlated → factor ×{" "}
                    <span className="text-[#FFE600] font-bold">{penaltyFactor.toFixed(3)}</span>
                  </div>
                </div>
              </div>

              <div className="border-t-2 border-[#00F5D4]/60 mt-3 pt-3">
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#FFE600] text-[10px] mb-1">
                  Result
                </div>
                <div className="font-[family-name:ui-monospace,SFMono-Regular,Menlo,monospace] text-white/80 text-[10px]">
                  {(pRaw * 100).toFixed(2)}% × {penaltyFactor.toFixed(3)} ={" "}
                  <span className="text-[#FFE600] font-black text-sm">
                    {(finalHitProb * 100).toFixed(1)}%
                  </span>
                </div>
              </div>

              <div className="border-t-2 border-dashed border-white/10 mt-3 pt-3 text-white/50 text-[9px] leading-relaxed">
                Probabilities are <strong className="text-white/70">PrizePicks-implied</strong> from{" "}
                <span className="text-[#FF6B35] font-bold">demon</span> /{" "}
                <span className="text-white/70 font-bold">standard</span> /{" "}
                <span className="text-[#4ADE80] font-bold">goblin</span> odds. A real projection model
                (see Model Lab roadmap) could move them either direction.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
