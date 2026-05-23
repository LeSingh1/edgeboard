"use client";

import { motion } from "framer-motion";
import { Layers, TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import type { Lineup } from "@/lib/types";
import { cn } from "@/lib/cn";

interface PortfolioStrategyProps {
  lineups: Lineup[]; // already ranked by EV (best first)
}

/**
 * Tells the user how many of their N ranked lineups to actually enter.
 *
 *   - Expected profit of playing top-N = Σ EV of those lineups (linear regardless of correlation)
 *   - The right N = the number of +EV lineups. Going further adds -EV bets that drag the total down.
 *
 * Shows tier rows at meaningful cutoffs + an explicit recommendation.
 */
export function PortfolioStrategy({ lineups }: PortfolioStrategyProps) {
  const { tiers, positiveEvCount, recommendation } = useMemo(() => {
    const positiveEvCount = lineups.filter((l) => l.expectedValue > 0).length;
    const total = lineups.length;

    // Cumulative stats by N
    const cumulative = lineups.reduce<
      { n: number; stake: number; ev: number; payout: number }[]
    >((acc, l, i) => {
      const prev = acc[i - 1] ?? { n: 0, stake: 0, ev: 0, payout: 0 };
      acc.push({
        n: i + 1,
        stake: prev.stake + l.entryCost,
        ev: prev.ev + l.expectedValue,
        payout: prev.payout + l.grossPayout,
      });
      return acc;
    }, []);

    // Pick meaningful tier breakpoints
    const breakpoints = new Set<number>([1, 3, 5, 10]);
    if (positiveEvCount > 0) breakpoints.add(positiveEvCount);
    if (total >= 1) breakpoints.add(total);
    const sorted = Array.from(breakpoints).filter((n) => n <= total).sort((a, b) => a - b);
    const tiers = sorted.map((n) => cumulative[n - 1]);

    const lineupAvg = lineups[0]?.entryCost ?? 20;
    const recommendation = {
      n: positiveEvCount,
      stake: positiveEvCount * lineupAvg,
      ev: cumulative[positiveEvCount - 1]?.ev ?? 0,
      roi:
        positiveEvCount > 0 && cumulative[positiveEvCount - 1]
          ? cumulative[positiveEvCount - 1].ev / cumulative[positiveEvCount - 1].stake
          : 0,
    };

    return { tiers, positiveEvCount, recommendation };
  }, [lineups]);

  if (lineups.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-3xl border-4 border-[#00F5D4] bg-gradient-to-br from-[#00F5D4]/15 via-[#7B2FFF]/15 to-[#FFE600]/15 backdrop-blur-sm overflow-hidden mt-10"
    >
      <div className="p-6 md:p-8">
        <div className="flex items-center gap-3 mb-3">
          <div
            className="w-12 h-12 rounded-xl border-4 flex items-center justify-center flex-shrink-0"
            style={{ borderColor: "#FFE600", color: "#00F5D4" }}
          >
            <Layers size={20} strokeWidth={3} aria-hidden />
          </div>
          <div>
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-2xl text-shadow-1">
              Portfolio strategy
            </h2>
            <p className="text-white/50 text-xs uppercase tracking-widest font-bold">
              How many of these {lineups.length} lineups to actually enter
            </p>
          </div>
        </div>

        {/* Recommendation banner */}
        <div
          className={cn(
            "rounded-2xl border-4 p-4 mb-5 flex items-start gap-3",
            positiveEvCount === 0
              ? "border-[#F87171] bg-[#F87171]/10"
              : "border-dashed border-[#FFE600] bg-[#FFE600]/5",
          )}
        >
          {positiveEvCount === 0 ? (
            <>
              <AlertTriangle size={24} className="text-[#F87171] flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#F87171] text-xs">
                  Skip this session
                </div>
                <p className="text-white/80 text-sm mt-1">
                  None of these {lineups.length} lineups make money long-term. PrizePicks keeps more
                  than every slip here pays back at these odds. Add more picks, change variants in your
                  bench, or wait for a better board.
                </p>
              </div>
            </>
          ) : (
            <>
              <TrendingUp size={24} className="text-[#4ADE80] flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[#FFE600] text-xs">
                  Recommended portfolio
                </div>
                <p className="text-white/90 text-sm mt-1">
                  Enter the <strong className="text-[#FFE600]">top {recommendation.n}</strong> of{" "}
                  {lineups.length} lineups
                  {positiveEvCount === lineups.length
                    ? " (every one makes money long-term — rare, take it)"
                    : ""}
                  .
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <RecStat label="Total stake" value={`$${recommendation.stake.toFixed(0)}`} accent="#FF3AF2" />
                  <RecStat
                    label="Expected profit"
                    value={`${recommendation.ev >= 0 ? "+" : ""}$${recommendation.ev.toFixed(2)}`}
                    accent={recommendation.ev >= 0 ? "#4ADE80" : "#F87171"}
                  />
                  <RecStat
                    label="Portfolio ROI"
                    value={`${recommendation.roi >= 0 ? "+" : ""}${(recommendation.roi * 100).toFixed(1)}%`}
                    accent={recommendation.roi >= 0 ? "#4ADE80" : "#F87171"}
                  />
                </div>
                <p className="text-white/50 text-xs mt-3 leading-relaxed">
                  Beyond rank #{positiveEvCount}, every lineup loses money long-term — adding them
                  <strong className="text-white/70"> reduces </strong> your average profit. Stop here.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Tier breakdown table */}
        <div>
          <div className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-[#00F5D4] mb-2">
            What playing top-N looks like
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-white/40 uppercase tracking-widest text-[10px] font-bold">
                  <th className="text-left p-2 font-bold">Tier</th>
                  <th className="text-right p-2 font-bold">Stake</th>
                  <th className="text-right p-2 font-bold">Expected profit</th>
                  <th className="text-right p-2 font-bold">Portfolio ROI</th>
                  <th className="text-right p-2 font-bold">Vs. recommended</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((tier) => {
                  if (!tier) return null;
                  const isRec = tier.n === positiveEvCount;
                  const beyond = tier.n > positiveEvCount;
                  const roi = tier.stake > 0 ? tier.ev / tier.stake : 0;
                  return (
                    <tr
                      key={tier.n}
                      className={cn(
                        "border-t border-white/10",
                        isRec && "bg-[#FFE600]/10",
                      )}
                    >
                      <td className="p-2 font-[family-name:var(--font-heading)] font-black">
                        Top {tier.n}
                        {isRec && (
                          <span className="ml-2 inline-block bg-[#FFE600] text-[#0D0D1A] rounded-full px-2 py-0.5 text-[8px] uppercase tracking-widest font-black">
                            Sweet spot
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-right text-white/80 font-bold">
                        ${tier.stake.toFixed(0)}
                      </td>
                      <td
                        className="p-2 text-right font-[family-name:var(--font-heading)] font-black"
                        style={{ color: tier.ev >= 0 ? "#4ADE80" : "#F87171" }}
                      >
                        {tier.ev >= 0 ? "+" : ""}${tier.ev.toFixed(2)}
                      </td>
                      <td
                        className="p-2 text-right font-bold"
                        style={{ color: roi >= 0 ? "#4ADE80" : "#F87171" }}
                      >
                        {roi >= 0 ? "+" : ""}{(roi * 100).toFixed(1)}%
                      </td>
                      <td className="p-2 text-right">
                        {beyond ? (
                          <span className="text-[#F87171] font-bold flex items-center justify-end gap-1">
                            <TrendingDown size={11} strokeWidth={3} /> drag
                          </span>
                        ) : isRec ? (
                          <span className="text-[#FFE600] font-bold">★ optimal</span>
                        ) : (
                          <span className="text-white/40">under-bet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Math explanation */}
        <details className="mt-5">
          <summary className="text-white/50 hover:text-[#00F5D4] text-[11px] uppercase tracking-widest font-bold cursor-pointer transition-colors">
            How this is calculated
          </summary>
          <p className="text-white/60 text-xs mt-2 leading-relaxed">
            <strong className="text-white/80">Expected profit</strong> for a stack of lineups equals
            the <em>sum</em> of each lineup&apos;s individual avg $ per play — that&apos;s true even when
            lineups share picks. The shared picks make your week lumpier (some weeks all hit, some weeks
            all miss together), but the long-run average is just the sum.
            <br />
            <br />
            <strong className="text-white/80">Why stop counting at the money-makers:</strong> every
            lineup beyond rank #{positiveEvCount} loses money long-term — paying PrizePicks for
            a slot that drags your average profit down, not up.
          </p>
        </details>
      </div>
    </motion.div>
  );
}

function RecStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border-4 px-3 py-2" style={{ borderColor: accent }}>
      <div className="text-[9px] uppercase tracking-widest font-bold text-white/60">{label}</div>
      <div
        className="font-[family-name:var(--font-heading)] font-black text-xl"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}
