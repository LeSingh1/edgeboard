"use client";

/**
 * Budget chat: the user types something like
 *   "I have $10, what's the best way to spend it tomorrow?"
 * and the app reads the budget out of the message, runs the optimizer over
 * the live board at a few candidate entry sizes, then proposes one or two
 * concrete allocations.
 *
 * Pure client-side: the optimizer is JS and runs in milliseconds against
 * the props the auto-pilot page already loaded. No new API roundtrip.
 *
 * Design constraints:
 * - Don't hallucinate dollar amounts. Every number rendered is computed.
 * - Default to a SAFE plan (multiple smaller lineups) and surface a
 *   LOTTERY plan (one larger lineup, more payout, more variance) so the
 *   user can pick a risk profile rather than us picking for them.
 * - If we can't parse a budget, ask the user for one rather than guessing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Sparkles, Loader2, Bot, User, MessageSquare } from "lucide-react";
import { buildAutoLineups } from "@/lib/autoPilot";
import { useProjectionStore } from "@/stores/projectionStore";
import { POWER_MULTIPLIERS, FLEX_PAYOUT_TABLES, ODDS_FACTOR } from "@/lib/optimizer";
import type { ProjectionResult } from "@/lib/realProjections";
import type { Lineup, Prop } from "@/lib/types";

interface AutoPilotChatProps {
  /** Live PrizePicks board. The chat is hidden when this is null. */
  board: { props: Prop[] } | null;
}

interface PlanOption {
  /** Short label users can compare at a glance — "Safe split", "Lottery", etc. */
  label: string;
  /** One-sentence rationale rendered under the label. */
  rationale: string;
  entryCost: number;
  lineupCount: number;
  lineupSize: number;
  lineups: Lineup[];
  /** Expected gross dollar return summed across all proposed lineups. */
  expectedReturn: number;
  /** Probability that AT LEAST ONE lineup in the plan hits its payout tier. */
  probAtLeastOneWins: number;
  /** Probability all lineups hit their payout tier. */
  probAllWin: number;
  /** Sum of all stakes (caps the budget). */
  totalStake: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Optional plan attached to an assistant message. */
  plans?: PlanOption[];
  /** Label of the plan that should render in expanded form by default. */
  recommendedLabel?: string;
}

const INITIAL_GREETING: Message = {
  id: "greet",
  role: "assistant",
  text:
    "Tell me your budget and how you want to play. Example: \"I have $10, give me the best way to spend it tomorrow\" — I'll come back with one safe split and one lottery shot built from the live board.",
};

/** Extract a dollar budget from free text. Accepts "$10", "10 dollars",
 *  "10 bucks", "ten dollars" — returns null when nothing parses. */
function parseBudget(message: string): number | null {
  const lower = message.toLowerCase();

  // $10 / $10.50 / $1,000
  const dollarSign = lower.match(/\$\s*([0-9]+(?:[.,][0-9]+)?)/);
  if (dollarSign) {
    const n = Number(dollarSign[1].replace(",", ""));
    if (Number.isFinite(n) && n > 0) return n;
  }

  // "10 dollars" / "25 bucks"
  const numWord = lower.match(/([0-9]+(?:[.,][0-9]+)?)\s*(dollars?|bucks?|usd)\b/);
  if (numWord) {
    const n = Number(numWord[1].replace(",", ""));
    if (Number.isFinite(n) && n > 0) return n;
  }

  // "I have 10 to spend" — last-ditch bare number near "have/spend/budget"
  const bare = lower.match(/(?:have|spend|budget|use|wager)\s*([0-9]+)\b/);
  if (bare) {
    const n = Number(bare[1]);
    if (Number.isFinite(n) && n > 0 && n <= 10000) return n;
  }

  return null;
}

/** Detect an intent hint in the user's message. Lets the response weight
 *  Safe vs. Lottery without us choosing for them silently. */
type Intent = "safe" | "lottery" | "balanced";
function parseIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (/\b(safe|safer|conservative|low risk|hit|cash|guaranteed|grind)\b/.test(m)) return "safe";
  if (/\b(big|lottery|moonshot|max payout|huge|swing|all in|win big|cash out)\b/.test(m)) return "lottery";
  return "balanced";
}

/**
 * Build a single plan: K lineups of the same size, each at the same entry.
 *
 * Hit probability for "at least one wins" comes straight from the per-lineup
 * hit probability — independence-assumption — same as the rest of the app.
 * The picks themselves are pulled through the diversifier, so the slips
 * aren't near-duplicates.
 */
function buildPlan(
  label: string,
  rationale: string,
  props: Prop[],
  entryCost: number,
  lineupSize: number,
  lineupCount: number,
  realProjections: Record<string, ProjectionResult>,
): PlanOption | null {
  const r = buildAutoLineups(props, lineupSize, lineupCount, entryCost, {
    realProjections,
    diversify: lineupCount > 1,
    excludeLive: true,
    excludeCombo: true,
  });
  const lineups = r.lineups.filter((l) => l.picks.length === lineupSize);
  if (lineups.length === 0) return null;
  const expectedReturn = lineups.reduce((s, l) => s + l.hitProbability * l.grossPayout, 0);
  const probAllWin = lineups.reduce((p, l) => p * l.hitProbability, 1);
  const probNoneWin = lineups.reduce((p, l) => p * (1 - l.hitProbability), 1);
  return {
    label,
    rationale,
    entryCost,
    lineupCount: lineups.length,
    lineupSize,
    lineups,
    expectedReturn,
    probAtLeastOneWins: 1 - probNoneWin,
    probAllWin,
    totalStake: entryCost * lineups.length,
  };
}

/**
 * Generate up to three plan options for a budget.
 *
 *   Safe split — many small lineups, smaller size, max hit probability
 *   Balanced  — 2-3 mid-sized lineups, mix of payout + hit
 *   Lottery   — one larger lineup at full budget, highest payout multiplier
 *
 * Trade-off ordering matters: we render in budget-friendly order (safe →
 * lottery) so the user reads safer first.
 */
function generatePlans(props: Prop[], budget: number, intent: Intent, real: Record<string, ProjectionResult>): PlanOption[] {
  const out: PlanOption[] = [];

  // Safe split: divide budget into ~3-5 small lineups of size 3, $1-$5 each.
  // Use the largest divisor that keeps per-lineup entry ≥ $1.
  const safeCount = budget >= 10 ? 5 : budget >= 5 ? Math.min(5, Math.floor(budget)) : 1;
  const safeEntry = Math.max(1, Math.floor((budget / Math.max(1, safeCount)) * 100) / 100);
  if (safeCount >= 2) {
    const safe = buildPlan(
      "Safe split",
      `${safeCount} flex lineups at $${safeEntry.toFixed(2)} each. Highest chance of cashing at least once; smaller per-slip payout.`,
      props,
      safeEntry,
      3,
      safeCount,
      real,
    );
    if (safe) out.push(safe);
  }

  // Balanced: 2 mid-sized lineups (4-pick), half budget each.
  const balCount = budget >= 4 ? 2 : 1;
  const balEntry = Math.max(1, Math.floor((budget / balCount) * 100) / 100);
  if (balCount === 2 && balEntry >= 1) {
    const bal = buildPlan(
      "Balanced",
      `2 lineups at $${balEntry.toFixed(2)} each, 4-pick Power. Decent payout per cash; covers both an OKC and a SAS angle if both are in the pool.`,
      props,
      balEntry,
      4,
      balCount,
      real,
    );
    if (bal) out.push(bal);
  }

  // Lottery: one big lineup, max size that the pool supports.
  // 5-pick is the size with the best EV-per-dollar most days; 6-pick has
  // way lower MG so we don't push it as the lottery default.
  const lotEntry = budget;
  const lot = buildPlan(
    "Lottery",
    `1 lineup at $${lotEntry.toFixed(2)}, 5-pick Flex. Biggest payout if it lands; least likely to cash at all.`,
    props,
    lotEntry,
    5,
    1,
    real,
  );
  if (lot) out.push(lot);

  // Filter to the intent: keep all three but mark which one we'd recommend.
  // The chat text addresses the recommendation; the cards remain visible
  // so the user can pick.
  return out;
}

/** Pick the recommended option based on user's intent. */
function pickRecommended(plans: PlanOption[], intent: Intent): PlanOption | null {
  if (plans.length === 0) return null;
  if (intent === "safe") {
    return plans.find((p) => p.label === "Safe split") ?? plans[0];
  }
  if (intent === "lottery") {
    return plans.find((p) => p.label === "Lottery") ?? plans[plans.length - 1];
  }
  // Balanced: maximize expected return, fall back to safe if no balanced.
  return [...plans].sort((a, b) => b.expectedReturn - a.expectedReturn)[0];
}

function summarizePlan(plan: PlanOption): string {
  const ev = plan.expectedReturn - plan.totalStake;
  const pPct = (plan.probAtLeastOneWins * 100).toFixed(0);
  const evSign = ev >= 0 ? "+" : "";
  return (
    `${plan.lineupCount}× ${plan.lineupSize}-pick at $${plan.entryCost.toFixed(2)} each. ` +
    `Hits at least once ~${pPct}% of the time. Expected return $${plan.expectedReturn.toFixed(2)} on $${plan.totalStake.toFixed(2)} staked (${evSign}$${ev.toFixed(2)} EV).`
  );
}

export function AutoPilotChat({ board }: AutoPilotChatProps) {
  const [messages, setMessages] = useState<Message[]>([INITIAL_GREETING]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const projections = useProjectionStore((s) => s.byProp);

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const propsAvailable = useMemo(() => (board?.props ?? []).length, [board]);

  const send = () => {
    const text = input.trim();
    if (!text || thinking || !board) return;
    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setThinking(true);

    // Optimizer is fast (<200ms) but we yield to next tick so the user
    // sees the "thinking" indicator. Avoids the response feeling robotic.
    setTimeout(() => {
      try {
        const reply = respond(text, board.props, projections);
        setMessages((prev) => [...prev, reply]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            text: `Couldn't generate a plan — ${err instanceof Error ? err.message : "unknown error"}. Try again with a clear budget like "$10".`,
          },
        ]);
      } finally {
        setThinking(false);
      }
    }, 320);
  };

  if (!board || propsAvailable === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center">
        <MessageSquare className="w-6 h-6 mx-auto text-white/40" />
        <p className="text-white/60 text-sm mt-3">
          The board isn&apos;t loaded yet — once props come in you&apos;ll be able
          to ask the autopilot for a budget plan.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-[#7B2FFF]/30 bg-gradient-to-br from-[#7B2FFF]/[0.04] via-transparent to-[#00F5D4]/[0.04] overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-white/10 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#7B2FFF]/15 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-[#7B2FFF]" />
        </div>
        <div className="flex-1">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tight text-sm">
            Autopilot chat
          </div>
          <div className="text-[11px] text-white/50">
            Ask in plain English; the model picks the picks.
          </div>
        </div>
        <div className="text-[10px] text-white/40 font-mono">{propsAvailable} props live</div>
      </div>

      {/* Scrollable message list */}
      <div
        ref={scrollerRef}
        className="h-[480px] overflow-y-auto px-5 py-4 space-y-4"
      >
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </AnimatePresence>
        {thinking && (
          <div className="flex items-center gap-2 text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Checking the live board…</span>
          </div>
        )}
      </div>

      {/* Input */}
      <form
        className="border-t border-white/10 px-3 py-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Try: "I have $10, what should I play tomorrow?"'
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[#7B2FFF]/60"
          disabled={thinking}
        />
        <button
          type="submit"
          disabled={thinking || !input.trim()}
          className="px-4 py-2.5 rounded-xl bg-[#7B2FFF] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#7B2FFF]/90 transition"
        >
          <Send className="w-3.5 h-3.5" />
          Send
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
          isUser ? "bg-white/8" : "bg-[#7B2FFF]/15"
        }`}
      >
        {isUser ? (
          <User className="w-3.5 h-3.5 text-white/70" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-[#7B2FFF]" />
        )}
      </div>
      <div className={`flex-1 max-w-[88%] ${isUser ? "text-right" : ""}`}>
        <div
          className={`inline-block text-left px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? "bg-[#7B2FFF]/20 border border-[#7B2FFF]/30 rounded-tr-md"
              : "bg-white/5 border border-white/10 rounded-tl-md"
          }`}
        >
          {message.text}
        </div>
        {message.plans && message.plans.length > 0 && (
          <div className="mt-3 grid gap-2.5">
            {message.plans.map((p) => (
              <PlanCard
                key={p.label}
                plan={p}
                defaultExpanded={p.label === message.recommendedLabel}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function PlanCard({ plan, defaultExpanded = false }: { plan: PlanOption; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const ev = plan.expectedReturn - plan.totalStake;
  const evPos = ev >= 0;
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 overflow-hidden">
      <button
        type="button"
        className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-white/[0.03] transition"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase text-[11px] tracking-widest text-[#00F5D4]">
            {plan.label}
          </div>
          <div className="text-xs text-white/70 mt-0.5">
            {plan.lineupCount}× {plan.lineupSize}-pick · ${plan.entryCost.toFixed(2)} each
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-white/50">If lands</div>
          <div className="text-base font-bold text-[#FFE600]">
            ${plan.lineups.reduce((s, l) => s + l.grossPayout, 0).toFixed(0)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-white/50">EV</div>
          <div className={`text-sm font-bold ${evPos ? "text-[#4ADE80]" : "text-[#FF6B35]"}`}>
            {evPos ? "+" : ""}${ev.toFixed(2)}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-white/10 pt-2 text-[11px] text-white/60 space-y-2">
          <div>
            P(at least one cashes): <span className="text-white font-bold">{(plan.probAtLeastOneWins * 100).toFixed(1)}%</span>
            {plan.lineupCount > 1 && (
              <>
                {" · "}P(all cash): <span className="text-white font-bold">{(plan.probAllWin * 100).toFixed(1)}%</span>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            {plan.lineups.map((l, i) => (
              <details
                key={l.id ?? i}
                open
                className="rounded-lg bg-white/[0.02] border border-white/5"
              >
                <summary className="px-2.5 py-1.5 cursor-pointer flex items-center justify-between text-xs text-white/80">
                  <span>
                    Lineup #{i + 1} · {l.picks.length}-pick {l.playType} · {(l.hitProbability * 100).toFixed(1)}% hit
                  </span>
                  <span className="font-mono text-[#FFE600]">
                    ${l.grossPayout.toFixed(0)}
                  </span>
                </summary>
                <ul className="px-3 pb-2 space-y-0.5">
                  {l.picks.map((pp, j) => (
                    <li key={j} className="text-[10px] text-white/55 flex items-center justify-between gap-2">
                      <span className="truncate">
                        <span className="text-white/80 font-medium">{pp.prop.playerName}</span>{" "}
                        <span className="text-white/50">{pp.prop.statType}</span>{" "}
                        <span className={pp.side === "more" ? "text-[#4ADE80]" : "text-[#FF6B35]"}>
                          {pp.side === "more" ? "Over" : "Under"} {pp.prop.line}
                        </span>
                      </span>
                      <span className="font-mono text-white/40 shrink-0">
                        {(pp.probability * 100).toFixed(0)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Convert the user's free-form message into an assistant reply with an
 * attached plan. All numbers in the reply derive from the optimizer.
 */
function respond(
  message: string,
  props: Prop[],
  projections: Record<string, ProjectionResult>,
): Message {
  const budget = parseBudget(message);
  const intent = parseIntent(message);

  if (budget === null) {
    return {
      id: `a-${Date.now()}`,
      role: "assistant",
      text:
        'I didn\'t catch a dollar amount. Tell me what you want to wager — "$5", "$25", "10 bucks" — and any preference for safe vs. lottery. I\'ll come back with a concrete plan.',
    };
  }

  if (budget < 1) {
    return {
      id: `a-${Date.now()}`,
      role: "assistant",
      text:
        "PrizePicks won't take an entry under $1. Bump the budget to at least $1 and I'll build the plan.",
    };
  }

  const plans = generatePlans(props, budget, intent, projections);
  if (plans.length === 0) {
    return {
      id: `a-${Date.now()}`,
      role: "assistant",
      text:
        "The live board doesn't have enough strong picks right now to build a $" +
        budget +
        " plan. Try again closer to game time when more props are posted.",
    };
  }

  const rec = pickRecommended(plans, intent) ?? plans[0];

  const intentNote =
    intent === "safe"
      ? " You asked to play it safe, so I'm leading with the Safe split."
      : intent === "lottery"
        ? " You asked for the big swing, so I'm leading with the Lottery."
        : "";

  const text =
    `On a $${budget.toFixed(2)} budget against the live board I'd recommend ` +
    `the ${rec.label.toLowerCase()}: ${summarizePlan(rec)}` +
    intentNote +
    "\n\nTap any card to expand the picks.";

  return {
    id: `a-${Date.now()}`,
    role: "assistant",
    text,
    plans,
    recommendedLabel: rec.label,
  };
}

// Re-export multipliers used by anyone introspecting the chat module.
export { POWER_MULTIPLIERS, FLEX_PAYOUT_TABLES, ODDS_FACTOR };
