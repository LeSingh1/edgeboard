"use client";

import { motion } from "framer-motion";
import {
  Activity,
  TrendingUp,
  Calculator,
  Trophy,
  Sparkles,
  Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  POWER_MULTIPLIERS,
  FLEX_PAYOUT_TABLES,
  type FlexTier,
} from "@/lib/optimizer";
import { useBankrollStore, bankrollSummary } from "@/stores/bankrollStore";
import type { LeagueSummary, OddsType, Prop } from "@/lib/types";

interface ApiResponse {
  props: Prop[];
  leagues: LeagueSummary[];
  total: number;
  fetchedAt: string;
}

export default function ModelLabPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const records = useBankrollStore((s) => s.records);
  const summary = bankrollSummary(records);

  useEffect(() => {
    fetch("/api/props")
      .then((r) => r.json())
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <motion.h1
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow"
      >
        Model Lab
      </motion.h1>
      <p className="text-white/70 text-lg mt-3 max-w-2xl">
        All numbers below come from real sources: today&apos;s PrizePicks board, the published payout
        matrix, and your bankroll history. No mock data.
      </p>

      <div className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <HouseEdgePanel />
        <BankrollPanel summary={summary} entered={records.length} />
        <DistributionPanel data={data} loading={loading} />
        <OddsReferencePanel />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// 1. House edge — derived from PrizePicks' actual multipliers
// ════════════════════════════════════════════════════════════════════

function HouseEdgePanel() {
  // For Power Play with all-standard picks, every pick is 50% so slip hit rate
  // is 0.5^k. House edge = 1 - (slip_hit_rate × multiplier).
  const rows = [2, 3, 4, 5, 6].map((k) => {
    const mult = POWER_MULTIPLIERS[k];
    const breakeven = 1 / mult;
    const stdHitRate = Math.pow(0.5, k);
    const edge = 1 - stdHitRate * mult; // positive = house edge
    const fairMult = 1 / stdHitRate;
    return { k, mult, breakeven, stdHitRate, edge, fairMult };
  });

  return (
    <Panel
      icon={Calculator}
      title="House edge"
      subtitle="What PrizePicks' multipliers actually pay vs. a fair 50/50 line"
      accent="#FF3AF2"
      accent2="#FFE600"
    >
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-white/40 uppercase tracking-widest font-bold text-[10px]">
              <th className="text-left p-2 font-bold">Size</th>
              <th className="text-right p-2 font-bold">Payout</th>
              <th className="text-right p-2 font-bold">Fair payout</th>
              <th className="text-right p-2 font-bold">Need to hit</th>
              <th className="text-right p-2 font-bold">House edge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className="border-t border-white/10">
                <td className="p-2 font-[family-name:var(--font-heading)] font-black text-base">
                  {r.k}-pick
                </td>
                <td className="p-2 text-right font-[family-name:var(--font-heading)] font-black text-[#00F5D4]">
                  {r.mult}×
                </td>
                <td className="p-2 text-right text-white/60">{r.fairMult.toFixed(1)}×</td>
                <td className="p-2 text-right text-[#FFE600] font-bold">
                  {(r.breakeven * 100).toFixed(1)}%
                </td>
                <td
                  className="p-2 text-right font-[family-name:var(--font-heading)] font-black"
                  style={{ color: r.edge > 0.5 ? "#F87171" : r.edge > 0.3 ? "#FF6B35" : "#FFE600" }}
                >
                  {(r.edge * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-white/50 text-[11px] mt-4 leading-relaxed">
        Reading row 1: a 2-pick Power pays 3×, but the &quot;fair&quot; payout on two coin-flips
        is 4×. PrizePicks keeps 25% — that&apos;s the house edge. <strong className="text-[#FFE600]">
        To overcome the edge, your per-pick hit rate has to clear the &quot;need to hit&quot;
        column.</strong> Demons & goblins shift this slightly, but the structure stays.
      </p>
    </Panel>
  );
}

// ════════════════════════════════════════════════════════════════════
// 2. Bankroll — real user data from bankrollStore
// ════════════════════════════════════════════════════════════════════

function BankrollPanel({
  summary,
  entered,
}: {
  summary: ReturnType<typeof bankrollSummary>;
  entered: number;
}) {
  return (
    <Panel
      icon={Trophy}
      title="Your bankroll"
      subtitle="Slips you've marked entered + resolved on the leaderboard"
      accent="#FFE600"
      accent2="#7B2FFF"
    >
      {entered === 0 ? (
        <div className="py-8 text-center">
          <Sparkles size={36} className="mx-auto text-[#FFE600] mb-3" />
          <p className="text-white/60 text-sm">
            No entries yet. Generate a slip on the Optimizer page, click{" "}
            <span className="text-[#FFE600] font-bold">Mark entered</span> after you place it on
            PrizePicks, then mark won/lost when the games close.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <BankStat label="Entered" value={summary.enteredCount.toString()} accent="#FFE600" />
            <BankStat label="Resolved" value={summary.resolvedCount.toString()} accent="#00F5D4" />
            <BankStat
              label="Staked"
              value={`$${summary.totalStaked.toFixed(0)}`}
              accent="#FF3AF2"
            />
            <BankStat
              label="Profit"
              value={`${summary.profit >= 0 ? "+" : ""}$${summary.profit.toFixed(2)}`}
              accent={summary.profit >= 0 ? "#4ADE80" : "#F87171"}
            />
          </div>
          <div className="mt-4 rounded-xl border-4 border-dashed border-[#7B2FFF] p-3 text-center">
            <div className="text-[10px] text-white/60 uppercase tracking-widest font-bold">
              Lifetime ROI
            </div>
            <div
              className="font-[family-name:var(--font-display)] text-4xl mt-1"
              style={{ color: summary.roi >= 0 ? "#4ADE80" : "#F87171" }}
            >
              {summary.totalStaked > 0
                ? `${summary.roi >= 0 ? "+" : ""}${(summary.roi * 100).toFixed(1)}%`
                : "—"}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function BankStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl border-4 p-2 text-center" style={{ borderColor: accent }}>
      <div className="text-[9px] text-white/60 uppercase tracking-widest font-bold">{label}</div>
      <div
        className="font-[family-name:var(--font-display)] text-xl mt-0.5 truncate"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// 3. Live distribution — real PrizePicks board crunched
// ════════════════════════════════════════════════════════════════════

function DistributionPanel({
  data,
  loading,
}: {
  data: ApiResponse | null;
  loading: boolean;
}) {
  return (
    <Panel
      icon={Activity}
      title="Today's board"
      subtitle="Live PrizePicks distribution"
      accent="#00F5D4"
      accent2="#FF3AF2"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-white/50 py-6">
          <Loader2 size={18} className="animate-spin" /> loading live props…
        </div>
      ) : !data ? (
        <div className="text-[#F87171] text-sm py-4">Couldn&apos;t reach PrizePicks. Try refresh.</div>
      ) : (
        <DistributionContent data={data} />
      )}
    </Panel>
  );
}

function DistributionContent({ data }: { data: ApiResponse }) {
  const oddsCounts: Record<OddsType, number> = { standard: 0, demon: 0, goblin: 0 };
  const statCounts = new Map<string, number>();
  for (const p of data.props) {
    oddsCounts[p.oddsType] = (oddsCounts[p.oddsType] ?? 0) + 1;
    statCounts.set(p.statType, (statCounts.get(p.statType) ?? 0) + 1);
  }
  const total = data.total;
  const topStats = Array.from(statCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const topLeagues = data.leagues.slice(0, 5);

  return (
    <div className="space-y-4">
      {/* Total */}
      <div>
        <div className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-[#00F5D4] mb-2">
          {total.toLocaleString()} props live · {data.leagues.length} leagues
        </div>
      </div>

      {/* Odds type split — stacked bar */}
      <div>
        <div className="text-[10px] text-white/60 uppercase tracking-widest font-bold mb-1">
          odds-type split
        </div>
        <div className="h-8 rounded-lg overflow-hidden flex border-2 border-white/20">
          <div
            className="bg-[#FF6B35] flex items-center justify-center text-[10px] font-black text-[#0D0D1A]"
            style={{ width: `${(oddsCounts.demon / total) * 100}%` }}
            title={`${oddsCounts.demon} demons`}
          >
            {oddsCounts.demon > total * 0.08 && `${((oddsCounts.demon / total) * 100).toFixed(0)}%`}
          </div>
          <div
            className="bg-white/30 flex items-center justify-center text-[10px] font-black text-[#0D0D1A]"
            style={{ width: `${(oddsCounts.standard / total) * 100}%` }}
            title={`${oddsCounts.standard} standard`}
          >
            {oddsCounts.standard > total * 0.08 &&
              `${((oddsCounts.standard / total) * 100).toFixed(0)}%`}
          </div>
          <div
            className="bg-[#4ADE80] flex items-center justify-center text-[10px] font-black text-[#0D0D1A]"
            style={{ width: `${(oddsCounts.goblin / total) * 100}%` }}
            title={`${oddsCounts.goblin} goblins`}
          >
            {oddsCounts.goblin > total * 0.08 && `${((oddsCounts.goblin / total) * 100).toFixed(0)}%`}
          </div>
        </div>
        <div className="flex gap-3 mt-1 text-[10px] font-bold uppercase tracking-wider">
          <span className="text-[#FF6B35]">● {oddsCounts.demon.toLocaleString()} demon</span>
          <span className="text-white/70">● {oddsCounts.standard.toLocaleString()} std</span>
          <span className="text-[#4ADE80]">● {oddsCounts.goblin.toLocaleString()} goblin</span>
        </div>
      </div>

      {/* Top leagues */}
      <div>
        <div className="text-[10px] text-white/60 uppercase tracking-widest font-bold mb-1">
          top leagues
        </div>
        <div className="space-y-1">
          {topLeagues.map((lg) => (
            <div key={lg.name} className="flex items-center gap-2 text-xs">
              <div className="w-32 truncate font-bold text-white/80">{lg.name}</div>
              <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#FF3AF2] to-[#00F5D4]"
                  style={{ width: `${(lg.count / total) * 100}%` }}
                />
              </div>
              <div className="w-12 text-right text-[#FFE600] font-bold">{lg.count}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Top stat types */}
      <div>
        <div className="text-[10px] text-white/60 uppercase tracking-widest font-bold mb-1">
          top stat types
        </div>
        <div className="flex flex-wrap gap-1.5">
          {topStats.map(([stat, count]) => (
            <span
              key={stat}
              className="px-2 py-0.5 rounded-full border-2 border-[#7B2FFF] text-[10px] font-bold uppercase tracking-wider"
            >
              <span className="text-white/80">{stat}</span>{" "}
              <span className="text-[#FFE600] font-black">{count}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// 4. Odds reference — flex tables + odds-type math
// ════════════════════════════════════════════════════════════════════

function OddsReferencePanel() {
  return (
    <Panel
      icon={TrendingUp}
      title="Payout reference"
      subtitle="Power & Flex multiplier matrix + odds-type math"
      accent="#FF6B35"
      accent2="#00F5D4"
    >
      <div>
        <div className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-[#FF6B35] mb-2">
          Power Play
        </div>
        <div className="grid grid-cols-5 gap-1 text-center">
          {[2, 3, 4, 5, 6].map((k) => (
            <div
              key={k}
              className="rounded-lg border-2 border-[#FF6B35] py-2 px-1"
            >
              <div className="text-[10px] text-white/60 font-bold uppercase">{k}-pick</div>
              <div className="font-[family-name:var(--font-heading)] font-black text-xl text-[#FFE600]">
                {POWER_MULTIPLIERS[k]}×
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-[#00F5D4] mb-2">
          Flex Play
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-white/40 text-[10px] uppercase tracking-widest font-bold">
              <th className="text-left p-1 font-bold">Size</th>
              <th className="text-right p-1 font-bold">All hit</th>
              <th className="text-right p-1 font-bold">−1 miss</th>
              <th className="text-right p-1 font-bold">−2 miss</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(FLEX_PAYOUT_TABLES).map(([size, tiers]) => {
              const sortedTiers: FlexTier[] = [...tiers].sort((a, b) => b.hits - a.hits);
              const sizeNum = Number(size);
              return (
                <tr key={size} className="border-t border-white/10">
                  <td className="p-1 font-[family-name:var(--font-heading)] font-black">{size}</td>
                  {[sizeNum, sizeNum - 1, sizeNum - 2].map((hits, idx) => {
                    const tier = sortedTiers.find((t) => t.hits === hits);
                    return (
                      <td key={idx} className="p-1 text-right">
                        {tier ? (
                          <span className="text-[#00F5D4] font-bold">{tier.multiplier}×</span>
                        ) : (
                          <span className="text-white/20">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 pt-4 border-t-2 border-dashed border-white/15">
        <div className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest text-[#FFE600] mb-2">
          Odds-type modifiers
        </div>
        <div className="space-y-1.5 text-xs">
          <RefRow color="#FF6B35" label="Demon" payout="×1.25" pMore="40%" pLess="60%" />
          <RefRow color="#FFFFFF" label="Standard" payout="×1.00" pMore="50%" pLess="50%" />
          <RefRow color="#4ADE80" label="Goblin" payout="×0.85" pMore="58.8%" pLess="41.2%" />
        </div>
        <p className="text-white/50 text-[10px] mt-2 leading-relaxed">
          Each demon in a lineup multiplies the final payout by 1.25; each goblin by 0.85. Modifiers
          stack multiplicatively. Implied probabilities derived from the modifier offset.
        </p>
      </div>
    </Panel>
  );
}

function RefRow({
  color,
  label,
  payout,
  pMore,
  pLess,
}: {
  color: string;
  label: string;
  payout: string;
  pMore: string;
  pLess: string;
}) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span
        className="font-[family-name:var(--font-heading)] font-black uppercase text-[11px] w-20"
        style={{ color }}
      >
        {label}
      </span>
      <span className="text-white/60">payout {payout}</span>
      <span className="text-white/60 ml-auto">
        MORE <span className="text-[#FFE600] font-bold">{pMore}</span>
      </span>
      <span className="text-white/60">
        LESS <span className="text-[#FFE600] font-bold">{pLess}</span>
      </span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════

function Panel({
  icon: Icon,
  title,
  subtitle,
  accent,
  accent2,
  children,
}: {
  icon: typeof Activity;
  title: string;
  subtitle: string;
  accent: string;
  accent2: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="relative rounded-3xl border-4 p-6 backdrop-blur-sm bg-[#2D1B4E]/60 overflow-hidden"
      style={{ borderColor: accent, boxShadow: `5px 5px 0 ${accent2}` }}
    >
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-12 h-12 rounded-xl border-4 flex items-center justify-center flex-shrink-0"
          style={{ borderColor: accent2, color: accent }}
        >
          <Icon size={20} strokeWidth={3} aria-hidden />
        </div>
        <div>
          <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xl text-shadow-1">
            {title}
          </h2>
          <p className="text-white/50 text-xs uppercase tracking-widest font-bold">{subtitle}</p>
        </div>
      </div>
      {children}
    </motion.div>
  );
}
