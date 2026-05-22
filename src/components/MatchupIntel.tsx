"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import {
  Brain,
  ChevronDown,
  AlertCircle,
  TrendingUp as ArrowUp,
  TrendingDown as ArrowDown,
  Minus,
  Newspaper,
  Sparkles,
} from "lucide-react";
import type { IntelResponse } from "@/app/api/intel/route";
import type { ProjectionAdjustment } from "@/lib/realProjections";
import { cn } from "@/lib/cn";

interface MatchupIntelProps {
  /** Pre-fetched intel for this prop. null = not yet loaded; available=false = no data. */
  intel: IntelResponse | null | undefined;
  /** Stat-driven adjustments (recent form, vs-opponent) from the projection. */
  adjustments?: ProjectionAdjustment[];
  /** Final pMore after all adjustments — shown so user sees how it landed. */
  finalPMore?: number;
  /** Baseline pre-adjustment pMore — shown as the starting point. */
  baselinePMore?: number;
  /** Override the "MATCHUP INTEL" headline (optional). */
  title?: string;
}

/**
 * Expandable explainer showing how the AI graded a single pick:
 *   1. Baseline statistical projection (last N games)
 *   2. Stat-driven adjustments (recent form, vs-opponent)
 *   3. News-driven signals (injury, beef, motivation) from ESPN
 *   4. Combined final probability
 */
export function MatchupIntel({
  intel,
  adjustments,
  finalPMore,
  baselinePMore,
  title = "Matchup intel",
}: MatchupIntelProps) {
  const [expanded, setExpanded] = useState(false);

  const hasAdjustments = (adjustments?.length ?? 0) > 0;
  const hasIntel = intel?.available && intel.signals.length > 0;
  const hasNews = intel?.available && intel.newsCount > 0;

  // Nothing to show
  if (!hasAdjustments && !hasIntel && !hasNews && !intel) return null;

  // Compute total swing for the summary chip
  const adjSwing =
    adjustments?.reduce((s, a) => s + a.pMoreSwing, 0) ?? 0;
  const intelSwing = intel?.combinedSwing ?? 0;
  const totalSwing = adjSwing + intelSwing;
  const swingColor =
    Math.abs(totalSwing) < 0.01
      ? "#FFE600"
      : totalSwing > 0
        ? "#4ADE80"
        : "#F87171";

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border-2 border-dashed",
          "border-[#7B2FFF] bg-[#7B2FFF]/10 hover:bg-[#7B2FFF]/15 transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-[#7B2FFF]/40",
        )}
      >
        <span className="flex items-center gap-2">
          <Brain size={14} strokeWidth={3} className="text-[#7B2FFF]" />
          <span className="font-[family-name:var(--font-heading)] font-black uppercase text-[10px] tracking-widest text-[#7B2FFF]">
            {title}
          </span>
          {intel?.source === "heuristic+claude" && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded-full border-2 border-[#FFE600] text-[#FFE600] text-[8px] font-black uppercase tracking-widest">
              <Sparkles size={8} strokeWidth={3} />
              Claude
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {Math.abs(totalSwing) > 0.005 && (
            <span
              className="font-[family-name:var(--font-heading)] font-black text-[11px] tracking-widest"
              style={{ color: swingColor }}
            >
              {totalSwing > 0 ? "+" : ""}{(totalSwing * 100).toFixed(1)}%
            </span>
          )}
          <ChevronDown
            size={14}
            strokeWidth={3}
            className={cn(
              "text-white/50 transition-transform",
              expanded && "rotate-180 text-[#7B2FFF]",
            )}
          />
        </span>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 rounded-xl border-2 border-[#7B2FFF]/40 bg-[#0D0D1A]/60 p-3 space-y-3">
              {/* Probability waterfall */}
              {baselinePMore !== undefined && finalPMore !== undefined && (
                <div>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-white/40 mb-1">
                    How we got the number
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-white/60">Baseline</span>
                    <span className="font-[family-name:var(--font-heading)] font-black text-white">
                      {(baselinePMore * 100).toFixed(0)}%
                    </span>
                    {Math.abs(adjSwing) > 0.005 && (
                      <>
                        <span className="text-white/40">→</span>
                        <span className="text-white/60">+ stats</span>
                        <span
                          className="font-[family-name:var(--font-heading)] font-black"
                          style={{ color: adjSwing > 0 ? "#4ADE80" : "#F87171" }}
                        >
                          {adjSwing > 0 ? "+" : ""}{(adjSwing * 100).toFixed(1)}%
                        </span>
                      </>
                    )}
                    {Math.abs(intelSwing) > 0.005 && (
                      <>
                        <span className="text-white/40">→</span>
                        <span className="text-white/60">+ intel</span>
                        <span
                          className="font-[family-name:var(--font-heading)] font-black"
                          style={{ color: intelSwing > 0 ? "#4ADE80" : "#F87171" }}
                        >
                          {intelSwing > 0 ? "+" : ""}{(intelSwing * 100).toFixed(1)}%
                        </span>
                      </>
                    )}
                    <span className="text-white/40">→</span>
                    <span
                      className="font-[family-name:var(--font-heading)] font-black"
                      style={{ color: swingColor }}
                    >
                      {(finalPMore * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              )}

              {/* Statistical adjustments */}
              {hasAdjustments && (
                <div>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-white/40 mb-1.5">
                    Statistical adjustments
                  </div>
                  <div className="space-y-1.5">
                    {adjustments!.map((a, i) => (
                      <AdjustmentRow key={i} adj={a} />
                    ))}
                  </div>
                </div>
              )}

              {/* Intel signals */}
              {hasIntel && (
                <div>
                  <div className="text-[9px] uppercase tracking-widest font-bold text-white/40 mb-1.5">
                    News & narrative ({intel.newsCount} {intel.newsCount === 1 ? "article" : "articles"})
                  </div>
                  <div className="space-y-1.5">
                    {intel.signals.map((s, i) => (
                      <SignalRow key={i} signal={s} />
                    ))}
                  </div>
                </div>
              )}

              {/* Headlines list — even when no signals fired, show the user what we read */}
              {hasNews && intel.topHeadlines.length > 0 && (
                <details className="text-[10px] text-white/50">
                  <summary className="cursor-pointer flex items-center gap-1 font-bold uppercase tracking-widest hover:text-white/70">
                    <Newspaper size={11} strokeWidth={3} />
                    {intel.topHeadlines.length} headlines scanned
                  </summary>
                  <ul className="mt-1.5 space-y-1 pl-3">
                    {intel.topHeadlines.slice(0, 5).map((h, i) => (
                      <li key={i} className="leading-snug">· {h.headline}</li>
                    ))}
                  </ul>
                </details>
              )}

              {/* Empty / unavailable states */}
              {intel?.available === false && (
                <div className="flex items-start gap-2 text-[10px] text-white/40">
                  <AlertCircle size={12} strokeWidth={3} className="mt-0.5 flex-shrink-0" />
                  <span>Intel unavailable — {intel.reason ?? "no news source for this sport"}</span>
                </div>
              )}
              {!intel && (
                <div className="text-[10px] text-white/40 italic">
                  Fetching news + signals…
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AdjustmentRow({ adj }: { adj: ProjectionAdjustment }) {
  const color =
    Math.abs(adj.pMoreSwing) < 0.005
      ? "#FFE600"
      : adj.pMoreSwing > 0
        ? "#4ADE80"
        : "#F87171";
  return (
    <div className="flex items-start gap-2">
      <span
        className="w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ borderColor: color, color }}
      >
        {adj.pMoreSwing > 0.005 ? (
          <ArrowUp size={10} strokeWidth={3} />
        ) : adj.pMoreSwing < -0.005 ? (
          <ArrowDown size={10} strokeWidth={3} />
        ) : (
          <Minus size={10} strokeWidth={3} />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-[family-name:var(--font-heading)] font-black text-[10px] uppercase tracking-widest text-white">
            {adj.label}
          </span>
          <span
            className="text-[10px] font-bold"
            style={{ color }}
          >
            {adj.pMoreSwing > 0 ? "+" : ""}{(adj.pMoreSwing * 100).toFixed(1)}%
          </span>
        </div>
        <div className="text-[10px] text-white/60 leading-snug">{adj.reason}</div>
      </div>
    </div>
  );
}

function SignalRow({ signal }: { signal: { label: string; direction: string; magnitude: number; confidence: number; evidence: string; source: string } }) {
  const dir = signal.direction;
  const color = dir === "positive" ? "#4ADE80" : dir === "negative" ? "#F87171" : "#FFE600";
  const swing = signal.magnitude * signal.confidence * (dir === "negative" ? -1 : dir === "positive" ? 1 : 0);
  return (
    <div className="flex items-start gap-2">
      <span
        className="w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ borderColor: color, color }}
      >
        {dir === "positive" ? (
          <ArrowUp size={10} strokeWidth={3} />
        ) : dir === "negative" ? (
          <ArrowDown size={10} strokeWidth={3} />
        ) : (
          <Minus size={10} strokeWidth={3} />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-[family-name:var(--font-heading)] font-black text-[10px] uppercase tracking-widest text-white">
            {signal.label}
          </span>
          <span className="text-[10px] font-bold" style={{ color }}>
            {swing > 0 ? "+" : ""}{(swing * 100).toFixed(1)}%
          </span>
          <span className="text-[8px] text-white/40 uppercase tracking-widest">
            conf {(signal.confidence * 100).toFixed(0)}%
          </span>
          {signal.source === "claude" && (
            <span className="text-[8px] text-[#FFE600] font-black uppercase tracking-widest">
              · Claude
            </span>
          )}
        </div>
        <div className="text-[10px] text-white/55 leading-snug italic line-clamp-2">{signal.evidence}</div>
      </div>
    </div>
  );
}
