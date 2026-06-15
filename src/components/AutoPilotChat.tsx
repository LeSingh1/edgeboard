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
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Sparkles, Loader2, Bot, User, MessageSquare, ArrowRight } from "lucide-react";
import { buildAutoLineups, type OddsPreference } from "@/lib/autoPilot";
import { useProjectionStore } from "@/stores/projectionStore";
import { useLineupStore } from "@/stores/lineupStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { POWER_MULTIPLIERS, FLEX_PAYOUT_TABLES, ODDS_FACTOR } from "@/lib/optimizer";
import { LIVE_PROJECTION_BASE_LEAGUES } from "@/lib/projectionCoverage";
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
  /** Real expected gross dollar return summed across lineups — from each
   *  lineup's true per-tier EV, NOT pAny × jackpot (the old overstatement). */
  expectedReturn: number;
  /** Probability AT LEAST ONE lineup returns a real profit (excludes the Flex
   *  bottom tier that cashes but still loses money). */
  probAtLeastOneProfits: number;
  /** Probability every lineup returns a real profit. */
  probAllProfit: number;
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
  // "Guaranteed / sure / profit / safe" all map to SAFE. We enumerate the
  // common misspellings of "guaranteed" (gauranteed, gaurenteed, garunteed,
  // garanteed) plus a loose g…r…teed catch — someone asking for a "guaranteed
  // win" wants the safest plan, not the lottery. ("win big" stays lottery.)
  if (
    /\b(safe|safer|safest|conservative|low risk|hit|cash|grind|profit|sure|lock|guarantee|guaranteed|gauranteed|gaurenteed|garanteed|garunteed|gaurteed)\b/.test(m) ||
    /\bg[au]{1,3}r\w*te+d\b/.test(m)
  ) {
    return "safe";
  }
  if (/\b(big|lottery|moonshot|max payout|huge|swing|all in|win big|cash out)\b/.test(m)) return "lottery";
  return "balanced";
}

/** Word-number → digit, so "one flex play lineup" reads as a count of 1. */
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Pull an explicit lineup count out of "give me 3 lineups", "one flex play
 *  lineup", "two slips", etc. Handles digits AND number-words, and tolerates a
 *  couple of filler words between the number and "lineup/slip" (so "one flex
 *  play lineup" reads as 1). Only matches lineup-nouns so it never grabs the
 *  budget or a pick-size like "3-pick". Returns null when no count is asked. */
function parseLineupCount(message: string): number | null {
  const m = message.toLowerCase();
  // Longest-first so "an"/"eleven" win over "a"/"one" in the alternation.
  const numAlt = ["\\d+", ...Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length)].join("|");
  const toN = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s] ?? NaN);
  // (1) number directly before a lineup noun: "3 lineups", "one slip", "two plays".
  // (2) number, 1-2 filler words, then lineup/slip: "one flex play lineup".
  const direct = new RegExp(`\\b(${numAlt})\\s*(?:lineups?|slips?|plays?|entries|entry|tickets?|boards?)\\b`);
  const spaced = new RegExp(`\\b(${numAlt})\\s+(?:\\w+\\s+){1,2}?(?:lineups?|slips?)\\b`);
  const hit = m.match(direct) ?? m.match(spaced);
  if (hit) {
    const n = toN(hit[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 12) return n;
  }
  return null;
}

/** Pull a requested picks-per-lineup size out of "5 pick flex", "a 6-pick",
 *  "3 picks", etc. PrizePicks lineups are 2-6 picks, so anything outside that
 *  is ignored. Returns null when no size is requested. Note: "pick" is NOT a
 *  lineup-count noun, so this never collides with parseLineupCount. */
function parsePickSize(message: string): number | null {
  const match = message.toLowerCase().match(/(\d+)[\s-]*picks?\b/);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n >= 2 && n <= 6) return n;
  }
  return null;
}

/** Detect a "consistent / safe players only" request — the user wants steady,
 *  low-variance players, not boom-or-bust ones. Triggers the optimizer's hard
 *  consistent-only mode (high floor + drops volatile players). */
function parseConsistentOnly(message: string): boolean {
  return /\bconsist(?:a|e)nt|\bsteady\b|\breliable\b|low[- ]?(?:variance|risk)|safe(?:st|r)?\s+(?:players?|picks?|bets?)|only\s+safe/i.test(
    message,
  );
}

/** Detect an explicit pick-style request in the message ("give me demons",
 *  "goblins only", "standard lines"). Returns null when none is named, so the
 *  caller falls back to the user's saved preference. Demon/goblin match their
 *  PrizePicks colors too ("red"/"green") only when paired with the pick word. */
function parseOddsPreference(message: string): OddsPreference | null {
  const m = message.toLowerCase();

  // Explicit "standard / regular / plain" request → standard lines only.
  if (/\b(standard|regular|plain|normal|vanilla)\b/.test(m)) return "standard";

  const mentionsGoblin = /\bgoblins?\b/.test(m);
  const mentionsDemon = /\b(demons?|devils?)\b/.test(m);
  // Exclusion only when the negation word sits IMMEDIATELY before the type word
  // (one optional color/quantifier in between). This is the fix for "no
  // overlapping all green goblins" — the "no" belongs to "overlapping", not
  // "goblins", so we must NOT treat the goblin mention as an exclusion.
  const NEG = "(?:no|not|without|avoid|skip|exclude|don'?t|neither)";
  const excludeGoblin = new RegExp(`\\b${NEG}\\b\\s+(?:any |more |the |green |red )?goblins?\\b`).test(m);
  const excludeDemon = new RegExp(`\\b${NEG}\\b\\s+(?:any |more |the |green |red )?demons?\\b`).test(m);
  const wantGoblin = mentionsGoblin && !excludeGoblin;
  const wantDemon = mentionsDemon && !excludeDemon;

  if (excludeGoblin && excludeDemon) return "standard"; // "no goblins or demons"
  if (wantGoblin && !wantDemon) return "goblin";
  if (wantDemon && !wantGoblin) return "demon";
  // Exactly one type ruled out → lean to the other.
  if (excludeGoblin) return "demon";
  if (excludeDemon) return "goblin";
  if (/\bbalanced\b|\bmix(?:ed)?\b/.test(m)) return "balanced";
  return null;
}

/** Map common phrasings ("WNBA only", "just NBA", "MLB") to the board's league
 *  name so the plan can be filtered to one sport. Order matters — WNBA is
 *  checked before NBA (it contains "nba"). Returns null when none is named. */
function parseSport(message: string): string | null {
  const m = message.toLowerCase();
  if (/\bwnba\b|women'?s?\s+(?:nba|basketball|hoops)/.test(m)) return "WNBA";
  if (/\bnba\b|\bbasketball\b/.test(m)) return "NBA";
  if (/\bmlb\b|\bbaseball\b/.test(m)) return "MLB";
  if (/\bnhl\b|\bhockey\b/.test(m)) return "NHL";
  if (/\btennis\b/.test(m)) return "TENNIS";
  if (/\bpga\b|\bgolf\b/.test(m)) return "PGA";
  if (/\b(?:world\s*cup|soccer|f[úu]tbol)\b/.test(m)) return "WORLD CUP";
  if (/\bnfl\b|american\s+football/.test(m)) return "NFL";
  if (/\bcs2\b|\bcs:?go\b|counter[- ]?strike/.test(m)) return "CS2";
  if (/\bufc\b|\bmma\b/.test(m)) return "UFC";
  if (/\blol\b|league\s+of\s+legends/.test(m)) return "LOL";
  return null;
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
  preference: OddsPreference,
  fillToCount = false,
  consistentOnly = false,
): PlanOption | null {
  const r = buildAutoLineups(props, lineupSize, lineupCount, entryCost, {
    realProjections,
    diversify: lineupCount > 1,
    excludeLive: true,
    excludeCombo: true,
    oddsPreference: preference,
    fillToCount,
    consistentOnly,
    // Read the saved safer-bets default at build time (store is a singleton;
    // getState() is safe outside React and avoids threading the flag through
    // respond/generatePlans on every call path).
    favorConsistency: useSettingsStore.getState().favorConsistency,
  });
  const lineups = r.lineups.filter((l) => l.picks.length === lineupSize);
  if (lineups.length === 0) return null;
  // Real expected gross return: each lineup's true EV (already net of its own
  // entry) plus that entry back. Uses the optimizer's correct per-tier EV
  // instead of the old `hitProbability × top-tier payout`, which pretended
  // every partial Flex cash paid the jackpot and massively overstated returns.
  const expectedReturn = lineups.reduce((s, l) => s + (l.expectedValue + l.entryCost), 0);
  // Honest profit odds: probProfit excludes the Flex tier that cashes but loses.
  const pProfit = (l: Lineup) => l.probProfit ?? l.hitProbability;
  const probAllProfit = lineups.reduce((p, l) => p * pProfit(l), 1);
  const probNoneProfit = lineups.reduce((p, l) => p * (1 - pProfit(l)), 1);
  return {
    label,
    rationale,
    entryCost,
    lineupCount: lineups.length,
    lineupSize,
    lineups,
    expectedReturn,
    probAtLeastOneProfits: 1 - probNoneProfit,
    probAllProfit,
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
function generatePlans(props: Prop[], budget: number, intent: Intent, real: Record<string, ProjectionResult>, preference: OddsPreference, consistentOnly = false): PlanOption[] {
  const out: PlanOption[] = [];

  // Safe split: divide budget into up to 10 small lineups of size 3, $1-$5 each.
  // Use the largest divisor that keeps per-lineup entry ≥ $1.
  const safeCount = budget >= 10 ? Math.min(10, Math.floor(budget)) : budget >= 5 ? Math.min(10, Math.floor(budget)) : 1;
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
      preference,
      false,
      consistentOnly,
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
      preference,
      false,
      consistentOnly,
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
    preference,
    false,
    consistentOnly,
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
  if (intent === "lottery") {
    return plans.find((p) => p.label === "Lottery") ?? plans[plans.length - 1];
  }
  if (intent === "safe") {
    // Highest REAL chance of actually turning a profit — the honest answer to
    // "give me a guaranteed win" (nothing is truly guaranteed; this is closest).
    return [...plans].sort((a, b) => b.probAtLeastOneProfits - a.probAtLeastOneProfits)[0];
  }
  // Balanced: best REAL expected value (net of stake). Now that EV is honest,
  // this no longer auto-crowns the lottery via the old pAny × jackpot bug.
  return [...plans].sort(
    (a, b) => (b.expectedReturn - b.totalStake) - (a.expectedReturn - a.totalStake),
  )[0];
}

/** Most picks any two lineups in a plan share — 0 means fully independent,
 *  `size` means identical. Used to be honest when a thin board forces the
 *  filled-to-count slips to overlap heavily (they're separate entries, but not
 *  independent shots). */
function maxPairwiseOverlap(lineups: Lineup[]): number {
  let mx = 0;
  for (let i = 0; i < lineups.length; i++) {
    const a = new Set(lineups[i].picks.map((p) => p.prop.id));
    for (let j = i + 1; j < lineups.length; j++) {
      let s = 0;
      for (const p of lineups[j].picks) if (a.has(p.prop.id)) s++;
      if (s > mx) mx = s;
    }
  }
  return mx;
}

function summarizePlan(plan: PlanOption): string {
  const ev = plan.expectedReturn - plan.totalStake;
  const profitPct = (plan.probAtLeastOneProfits * 100).toFixed(0);
  const evSign = ev >= 0 ? "+" : "";
  const perSlip = plan.lineups[0]?.grossPayout ?? 0;
  const perSlipLabel = plan.lineupCount > 1
    ? `Best case each slip pays $${perSlip.toFixed(0)}.`
    : `Best case it pays $${perSlip.toFixed(0)}.`;
  return (
    `${plan.lineupCount}× ${plan.lineupSize}-pick at $${plan.entryCost.toFixed(2)} each. ` +
    `${perSlipLabel} ` +
    `~${profitPct}% chance at least one slip actually profits; real expected value ${evSign}$${ev.toFixed(2)} across all slips.`
  );
}

export function AutoPilotChat({ board }: AutoPilotChatProps) {
  const [messages, setMessages] = useState<Message[]>([INITIAL_GREETING]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const projections = useProjectionStore((s) => s.byProp);
  const fetchProjection = useProjectionStore((s) => s.fetchOne);
  const setResults = useLineupStore((s) => s.setResults);
  // Saved pick-style preference — used as the default when the message itself
  // doesn't name a style. An inline "give me demons" still overrides it.
  const oddsPreference = useSettingsStore((s) => s.oddsPreference);
  const anthropicKey = useSettingsStore((s) => s.anthropicKey);
  const router = useRouter();

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  /** Push a plan's lineups into the lineup store and navigate to /slips. */
  const handleViewSlips = (plan: PlanOption) => {
    setResults({
      lineups: plan.lineups,
      totalGenerated: plan.lineups.length,
      elapsedMs: 0,
      params: {
        lineupSize: plan.lineupSize,
        playType: plan.lineups[0]?.playType ?? "flex",
        entryCost: plan.entryCost,
        riskMode: "safe",
      },
    });
    router.push("/slips");
  };

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

    // Prior turns (before this message) give the LLM conversational memory, so
    // "2 per lineup" lands on top of an earlier "10 lineups, all goblins".
    const priorTurns = messages.map((m) => ({ role: m.role, text: m.text }));

    void (async () => {
      // 1. Parse the request with the LLM (real NLU). Falls back to the local
      //    regex parser if there's no API key or the call fails — the chat
      //    always responds, just less flexibly without a key.
      let parsed: ParsedIntent;
      try {
        const res = await fetch("/api/autopilot-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            history: priorTurns,
            anthropicKey: anthropicKey || undefined,
            sports: [...LIVE_PROJECTION_BASE_LEAGUES],
            propsAvailable: board.props.length,
          }),
        });
        if (!res.ok) throw new Error(`chat-route ${res.status}`);
        const j = await res.json();
        parsed = normalizeIntent(j.intent, oddsPreference);
      } catch {
        // No LLM (no API key / offline): give the regex fallback a little memory
        // by parsing the last few user turns together, so a follow-up like "$10"
        // still inherits an earlier "10 lineups, 2 picks, goblins, no overlap".
        const recentUserText = [
          ...priorTurns.filter((t) => t.role === "user").slice(-3).map((t) => t.text),
          text,
        ].join(". ");
        parsed = parseIntentLocally(recentUserText, oddsPreference);
      }

      // 2. Build the plan deterministically from the parsed intent. The model
      //    only interpreted the request; buildAutoLineups (+ the no-mock gate)
      //    produces every real pick.
      let reply: Message;
      try {
        reply = respond(parsed, board.props, projections);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            text: `Couldn't generate a plan — ${err instanceof Error ? err.message : "unknown error"}. Try again with a clear budget like "$10".`,
          },
        ]);
        setThinking(false);
        return;
      }
      // Show the plan immediately (implied/cached pricing), then upgrade it.
      setMessages((prev) => [...prev, reply]);
      setThinking(false);

      // Warm the REAL calibrated model for the props actually in the plan, then
      // re-score and swap the message in place — so the chat stops showing the
      // PrizePicks-implied placeholder odds for picks the model can price.
      try {
        const picks = new Map<string, Prop>();
        for (const pl of reply.plans ?? [])
          for (const l of pl.lineups) for (const pk of l.picks) picks.set(pk.prop.id, pk.prop);
        if (picks.size > 0) {
          await Promise.all([...picks.values()].map((p) => fetchProjection(p)));
          const fresh = useProjectionStore.getState().byProp;
          // No-mock: rebuild only from props whose REAL projection is available,
          // so the upgraded plan can't fall back to PrizePicks-implied pricing.
          const backed = board.props.filter((p) => fresh[p.id]?.available === true);
          const upgraded = respond(parsed, backed, fresh);
          setMessages((prev) => prev.map((m) => (m.id === reply.id ? { ...upgraded, id: reply.id } : m)));
        }
      } catch {
        /* real pricing failed — leave the league-filtered reply; it carries no
           uncovered-sport picks, only covered-league props the optimizer ranked */
      }
    })();
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
            <MessageBubble key={m.id} message={m} onViewSlips={handleViewSlips} />
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

function MessageBubble({ message, onViewSlips }: { message: Message; onViewSlips: (plan: PlanOption) => void }) {
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
                onViewSlips={onViewSlips}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function PlanCard({
  plan,
  defaultExpanded = false,
  onViewSlips,
}: {
  plan: PlanOption;
  defaultExpanded?: boolean;
  onViewSlips: (plan: PlanOption) => void;
}) {
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
          <div className="text-xs text-white/50">{plan.lineupCount > 1 ? "Top / slip" : "Best case"}</div>
          <div className="text-base font-bold text-[#FFE600]">
            ${plan.lineups[0]?.grossPayout.toFixed(0) ?? "0"}
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
            Chance ≥1 slip profits: <span className="text-white font-bold">{(plan.probAtLeastOneProfits * 100).toFixed(1)}%</span>
            {plan.lineupCount > 1 && (
              <>
                {" · "}all profit: <span className="text-white font-bold">{(plan.probAllProfit * 100).toFixed(1)}%</span>
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
                    Lineup #{i + 1} · {l.picks.length}-pick {l.playType} · {((l.probProfit ?? l.hitProbability) * 100).toFixed(1)}% profit
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
                          {pp.prop.standardLine != null && (
                            <span className="text-white/30"> (std {pp.prop.standardLine})</span>
                          )}
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
          {/* View on Slips button */}
          <button
            type="button"
            onClick={() => onViewSlips(plan)}
            className="w-full mt-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#7B2FFF]/20 border border-[#7B2FFF]/40 text-[#7B2FFF] text-xs font-bold uppercase tracking-widest hover:bg-[#7B2FFF]/30 transition"
          >
            View detailed metrics
            <ArrowRight size={12} strokeWidth={3} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Convert the user's free-form message into an assistant reply with an
 * attached plan. All numbers in the reply derive from the optimizer.
 */
/** The structured request the chat builds a plan from. Produced either by the
 *  LLM intent parser (/api/autopilot-chat) or, as a fallback, by the local
 *  regexes below. Decoupling parsing from building lets the model understand
 *  free-form phrasing while the deterministic optimizer (and the no-mock gate)
 *  still produces every real pick. */
export interface ParsedIntent {
  budget: number | null;
  intent: Intent;
  sport: string | null;
  preference: OddsPreference;
  consistentOnly: boolean;
  requestedCount: number | null;
  requestedSize: number | null;
  noOverlap: boolean;
  /** Optional LLM-written confirmation; unused when building (respond writes its
   *  own specific text), but available for future conversational polish. */
  reply: string | null;
  /** When the budget/info is missing, the question to ask instead of building. */
  clarifyingQuestion: string | null;
}

/** Fallback intent parser — the original regexes, used when the LLM route is
 *  unavailable (no API key, offline). Keeps the chat working without a key. */
function parseIntentLocally(message: string, savedPreference: OddsPreference): ParsedIntent {
  return {
    budget: parseBudget(message),
    intent: parseIntent(message),
    sport: parseSport(message),
    preference: parseOddsPreference(message) ?? savedPreference,
    consistentOnly: parseConsistentOnly(message),
    requestedCount: parseLineupCount(message),
    requestedSize: parsePickSize(message),
    noOverlap: /\bno\s+(overlap|overlapping|repeat)|don'?t\s+(repeat|overlap)|independent|unique\s+players\b/i.test(message),
    reply: null,
    clarifyingQuestion: null,
  };
}

/** Deterministic "I need your budget" ask that acknowledges everything we DID
 *  understand (count, size, style, no-overlap, sport). Used when no budget was
 *  given and the LLM didn't supply its own question (e.g. no API key) — so the
 *  chat confirms the request instead of repeating a generic prompt. */
function budgetAskText(parsed: ParsedIntent): string {
  const bits: string[] = [];
  if (parsed.requestedCount) bits.push(`${parsed.requestedCount} lineups`);
  if (parsed.requestedSize) bits.push(`${parsed.requestedSize} picks each`);
  if (parsed.preference === "goblin") bits.push("green goblins");
  else if (parsed.preference === "demon") bits.push("red demons");
  else if (parsed.preference === "standard") bits.push("standard lines");
  if (parsed.consistentOnly) bits.push("consistent players only");
  if (parsed.noOverlap) bits.push("no overlap");
  if (parsed.sport) bits.push(parsed.sport);
  const got = bits.length ? `Got it — ${bits.join(", ")}. ` : "";
  return `${got}I just need your budget — how much do you want to wager? (e.g. "$10", "$25")`;
}

/** Map the LLM route's JSON (0/"" sentinels) into a ParsedIntent. */
function normalizeIntent(raw: unknown, savedPreference: OddsPreference): ParsedIntent {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const intents = ["safe", "lottery", "balanced"];
  const prefs = ["balanced", "goblin", "demon", "standard"];
  const budget = num(r.budget);
  const count = Math.round(num(r.lineupCount));
  const size = Math.round(num(r.lineupSize));
  return {
    budget: budget > 0 ? budget : null,
    intent: (intents.includes(r.intent as string) ? r.intent : "balanced") as Intent,
    sport: str(r.sport) ? str(r.sport).toUpperCase() : null,
    preference: (prefs.includes(r.oddsPreference as string) ? r.oddsPreference : savedPreference) as OddsPreference,
    consistentOnly: !!r.consistentOnly,
    requestedCount: count > 0 ? count : null,
    requestedSize: size >= 2 ? size : null,
    noOverlap: !!r.noOverlap,
    reply: str(r.reply) || null,
    clarifyingQuestion: str(r.clarifyingQuestion) || null,
  };
}

function respond(
  parsed: ParsedIntent,
  props: Prop[],
  projections: Record<string, ProjectionResult>,
): Message {
  const { budget, intent, sport, preference, consistentOnly, noOverlap } = parsed;
  const consistencyNote = consistentOnly
    ? " Consistent players only — coinflip picks and boom-or-bust players (high game-to-game variance) were excluded."
    : "";
  // One-liner appended to replies so the user knows the style was honored.
  const styleNote =
    preference === "goblin"
      ? " Built from green goblins — easier lines, so higher hit chance but smaller payouts."
      : preference === "demon"
        ? " Built from red demons as you asked — bigger payouts, but these are meant to hit under ~45% of the time, so the profit odds read low on purpose."
        : preference === "standard"
          ? " Standard lines only — no goblins or demons in here."
          : "";
  // Filter the board to the requested league up front so EVERY plan respects
  // "WNBA only" / "just NBA" etc. (case-insensitive against the board's sport).
  const pool = sport ? props.filter((p) => p.sport.toUpperCase() === sport) : props;
  if (sport && pool.length === 0) {
    return {
      id: `a-${Date.now()}`,
      role: "assistant",
      text: `There are no ${sport} props on the board right now, so I can't build a ${sport}-only plan. Try another league or drop the sport filter.`,
    };
  }

  if (budget === null) {
    return {
      id: `a-${Date.now()}`,
      role: "assistant",
      text: parsed.clarifyingQuestion || budgetAskText(parsed),
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

  // Honor an explicit lineup count ("give me 3 lineups"). Split the budget
  // evenly across that many slips (>= $1 each) and build exactly that many,
  // diversified. Falls through to the Safe/Balanced/Lottery options if the
  // board is too thin to fill them.
  const { requestedCount, requestedSize } = parsed;
  if (requestedCount !== null || requestedSize !== null) {
    const maxAffordable = Math.floor(budget); // PrizePicks $1-per-slip minimum
    // Count defaults to 1 when only a pick-size was named ("a 5-pick flex").
    const count = Math.max(1, Math.min(requestedCount ?? 1, maxAffordable));
    const entryEach = Math.max(1, Math.floor((budget / count) * 100) / 100);
    // Honor an explicit "5 pick" size; otherwise size by intent.
    const size = requestedSize ?? (intent === "safe" ? 3 : intent === "lottery" ? 5 : 4);
    // In consistent-only mode the steady pool can be thin, so step the size
    // DOWN until we can fill it rather than padding with volatile picks. A
    // smaller all-consistent slip beats a bigger slip with coinflips in it.
    let plan: PlanOption | null = null;
    let builtSize = size;
    for (let s = size; s >= 2; s--) {
      plan = buildPlan(
        `${count} ${sport ? sport + " " : ""}lineups`,
        `${count} ${sport ? sport + " " : ""}lineups at $${entryEach.toFixed(2)} each, ${s}-pick.`,
        pool,
        entryEach,
        s,
        count,
        projections,
        preference,
        !noOverlap, // fill to the requested count UNLESS the user wants no overlap (independent slips only)
        consistentOnly,
      );
      if (plan) { builtSize = s; break; }
      if (!consistentOnly) break; // only downsize in consistent mode
    }
    if (plan) {
      const got = plan.lineupCount;
      const downsizeNote =
        consistentOnly && builtSize < size
          ? ` (You asked for ${size} picks, but only ${builtSize} players cleared the consistency bar — a ${builtSize}-pick of steady players is safer than padding to ${size} with volatile ones.)`
          : "";
      // Label the card by what we ACTUALLY built, not what was requested — a
      // "10 WNBA lineups" title over 3 cards reads as a bug.
      plan.label = `${got} ${sport ? sport + " " : ""}${got === 1 ? "lineup" : "lineups"}`;
      // Two distinct shortfall reasons: budget (can't afford N at $1 each) vs.
      // a board too thin to form N different slips even after filling.
      const shortNote =
        requestedCount !== null && got < requestedCount
          ? count < requestedCount
            ? ` (You asked for ${requestedCount}, but $${budget.toFixed(2)} at PrizePicks' $1 minimum only covers ${got}.)`
            : ` (You asked for ${requestedCount}, but the ${sport ? sport + " " : ""}board can only form ${got} valid ${builtSize}-pick ${got === 1 ? "slip" : "slips"} right now.)`
          : "";
      // Overlap honesty: when we filled to the requested count off a thin board,
      // the slips share picks — separate entries, but NOT independent shots, so
      // "only need 1 of N to hit" is weaker than it sounds. Say so.
      const overlap = got > 1 ? maxPairwiseOverlap(plan.lineups) : 0;
      const overlapNote =
        got > 1 && overlap >= builtSize - 1
          ? ` Heads up: the ${sport ? sport + " " : ""}board is thin, so some of these share ${overlap} of ${builtSize} picks — they're ${got} separate entries but not ${got} independent shots (if the shared picks miss, several slips go down together).`
          : got > 1 && overlap >= Math.ceil(builtSize / 2)
            ? ` Note: these overlap by up to ${overlap} of ${builtSize} picks, so they're not fully independent.`
            : "";
      const text =
        `Here ${got === 1 ? "is" : "are"} ${got} ${sport ? sport + " " : ""}${got === 1 ? "lineup" : "lineups"} on your ` +
        `$${budget.toFixed(2)} — $${entryEach.toFixed(2)} each.${shortNote}${downsizeNote} ${summarizePlan(plan)} ` +
        `No play is guaranteed; this is the highest-profit-chance build at that size.${styleNote}${consistencyNote}${overlapNote}` +
        `\n\nTap the card to expand the picks.`;
      return {
        id: `a-${Date.now()}`,
        role: "assistant",
        text,
        plans: [plan],
        recommendedLabel: plan.label,
      };
    }
    // Couldn't fill that many — fall through to the standard options below.
  }

  const plans = generatePlans(pool, budget, intent, projections, preference, consistentOnly);
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
      ? " Straight up: no PrizePicks play is a guaranteed profit — every entry carries the house edge, so spreading across the board can't make a sure thing. This is just the plan with the best real shot at ending the day ahead."
      : intent === "lottery"
        ? " You asked for the big swing, so I'm leading with the Lottery — lowest odds, biggest payout."
        : "";

  const text =
    `On a $${budget.toFixed(2)} budget against the live board I'd recommend ` +
    `the ${rec.label.toLowerCase()}: ${summarizePlan(rec)}` +
    intentNote +
    styleNote +
    consistencyNote +
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
