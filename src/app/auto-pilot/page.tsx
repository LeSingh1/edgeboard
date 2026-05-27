"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Sparkles,
  Zap,
  Trophy,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Layers,
  Sliders,
  Filter,
  Loader2,
  AlertTriangle,
  Wand2,
  MessageCircle,
  Send,
} from "lucide-react";
import {
  buildAutoLineups,
  pickAutoSize,
  parseRequest,
  gradeLineup,
  GRADE_COLOR,
  type AutoPilotResult,
  type ParsedRequest,
} from "@/lib/autoPilot";
import { useProjectionStore } from "@/stores/projectionStore";
import { useLineupStore } from "@/stores/lineupStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { OddsBadge } from "@/components/OddsBadge";
import { AnimatedPercent } from "@/components/AnimatedPercent";
import { accentHexFor, cn } from "@/lib/cn";
import type { LeagueSummary, Prop } from "@/lib/types";

/**
 * Chat thread shape. Assistant turns optionally carry the lineup that was
 * built for them so the bubble can show a compact result preview + grade.
 */
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Compact lineup summary, only set on assistant replies that produced one. */
  preview?: {
    lineupId: string;
    hitProb: number;
    grade: "A" | "B" | "C" | "D" | "F";
    grossPayout: number;
    expectedValue: number;
    size: number;
    playType: "power" | "flex";
    entry: number;
    count: number;
    picks: { player: string; statType: string; line: number; side: "more" | "less" }[];
  };
}

/**
 * Build a chat reply that summarizes what we understood + grades the top
 * lineup. When Claude returned a free-text reply we use that verbatim;
 * otherwise we fall back to a templated "Got it — X" summary built from
 * the parser's matched fields.
 */
function composeAssistantReply(
  _userText: string,
  parsed: ParsedRequest,
  resolved: { lineupCount: number; lineupSize: number; entry: number; sport: string },
  result: AutoPilotResult,
  claudeReply: string | null = null,
): ChatMessage {
  const top = result.lineups[0];
  if (!top) {
    return {
      role: "assistant",
      text:
        claudeReply ??
        "I couldn't find a valid lineup with that — the pool is too thin for the size you asked for, or all picks are on one team. Try a smaller size or a different sport.",
    };
  }

  const understood: string[] = [];
  if (parsed.matched.includes("count")) understood.push(`${resolved.lineupCount} ${resolved.lineupCount === 1 ? "slip" : "slips"}`);
  if (parsed.matched.includes("size")) understood.push(`${resolved.lineupSize}-pick`);
  if (parsed.matched.includes("entry")) understood.push(`$${resolved.entry} entry`);
  if (parsed.matched.includes("sport")) understood.push(resolved.sport);
  if (parsed.mode) understood.push(`${parsed.mode} mode`);

  const understoodLine =
    claudeReply ??
    (understood.length > 0
      ? `Got it — ${understood.join(" · ")}.`
      : `Going with our defaults — ${resolved.lineupCount} ${resolved.lineupSize}-pick slip${resolved.lineupCount === 1 ? "" : "s"} at $${resolved.entry}.`);

  const grade = gradeLineup(top.hitProbability);

  return {
    role: "assistant",
    text: understoodLine,
    preview: {
      lineupId: top.id,
      hitProb: top.hitProbability,
      grade,
      grossPayout: top.grossPayout,
      expectedValue: top.expectedValue,
      size: top.picks.length,
      playType: top.playType,
      entry: resolved.entry,
      count: resolved.lineupCount,
      picks: top.picks.map((p) => ({
        player: p.prop.playerName,
        statType: p.prop.statType,
        line: p.prop.line,
        side: p.side,
      })),
    },
  };
}

const ENTRY_PRESETS = [5, 10, 20, 50, 100] as const;
const LINEUP_SIZES = [2, 3, 4, 5, 6] as const;
const LINEUP_COUNTS = [1, 2, 3, 4, 5] as const;

/**
 * Defaults used whenever a control is left on "auto":
 *   count → 3   (gives variety without being overwhelming)
 *   size  → resolved at run-time by pickAutoSize() against the live board
 *   entry → $20 (PrizePicks median single-slip ticket)
 *   sport → ALL (no filter — auto = "we choose")
 */
const AUTO_COUNT_DEFAULT = 3;
const AUTO_ENTRY_DEFAULT = 20;
type AutoOr<T> = "auto" | T;

interface ApiResponse {
  props: Prop[];
  leagues: LeagueSummary[];
  total: number;
  fetchedAt: string;
}

export default function AutoPilotPage() {
  const router = useRouter();
  const setLineupResults = useLineupStore((s) => s.setResults);
  const byProp = useProjectionStore((s) => s.byProp);
  const anthropicKey = useSettingsStore((s) => s.anthropicKey);

  const [board, setBoard] = useState<ApiResponse | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [boardError, setBoardError] = useState<string | null>(null);

  // Controls — every knob can be left on "auto" so the user can hand the
  // whole decision (or any subset) to the algorithm.
  const [lineupCount, setLineupCount] = useState<AutoOr<number>>("auto");
  const [lineupSize, setLineupSize] = useState<AutoOr<number>>("auto");
  const [entry, setEntry] = useState<AutoOr<number>>("auto");
  const [sport, setSport] = useState<AutoOr<string>>("auto");
  const [crunching, setCrunching] = useState(false);
  const [result, setResult] = useState<AutoPilotResult | null>(null);
  /** What the algorithm actually picked when controls were on auto.
   *  Stored alongside the result so the UI can say "we chose 4-pick at $20". */
  const [resolvedParams, setResolvedParams] = useState<{
    lineupCount: number;
    lineupSize: number;
    entry: number;
    sport: string;
  } | null>(null);

  // Chat thread — natural-language requests like "I have $5, give me the
  // best lineup across all sports". Each turn is one user message + one
  // assistant reply; the assistant reply links to the lineup that was
  // built for that request.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");

  const allAuto =
    lineupCount === "auto" &&
    lineupSize === "auto" &&
    entry === "auto" &&
    sport === "auto";

  const setAllAuto = () => {
    setLineupCount("auto");
    setLineupSize("auto");
    setEntry("auto");
    setSport("auto");
  };

  // Fetch the board on mount. Same endpoint the live-board uses — already
  // cached for 5 min upstream, so this is cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/props");
        if (!res.ok) throw new Error(`Upstream ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        if (cancelled) return;
        setBoard(json);
        setBoardError(null);
      } catch (e) {
        if (cancelled) return;
        setBoardError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingBoard(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // How many props are available in the current sport filter — drives the
  // pre-flight number so the user knows what pool we're searching. `auto`
  // and explicit `ALL` both mean "no filter", so they're equivalent here.
  const filteredCount = useMemo(() => {
    if (!board) return 0;
    if (sport === "auto" || sport === "ALL") return board.total;
    return board.props.filter((p) => p.sport === sport).length;
  }, [board, sport]);

  // Top leagues for the sport pills — capped at 8 to keep the row tidy.
  const leagueOptions = useMemo<LeagueSummary[]>(() => {
    if (!board) return [];
    return [{ name: "ALL", count: board.total }, ...board.leagues.slice(0, 8)];
  }, [board]);

  /**
   * Resolve the current control state (with optional overrides from chat)
   * into a concrete `{count, size, entry, sport}` and run the optimizer.
   * Returns the resolved params + the AutoPilotResult so callers can chain
   * follow-up logic (chat does this to generate its reply text).
   */
  const runGenerate = async (
    overrides?: Partial<{ count: number; size: number; entry: number; sport: string }>,
  ): Promise<{
    resolved: { lineupCount: number; lineupSize: number; entry: number; sport: string };
    result: AutoPilotResult;
  } | null> => {
    if (!board) return null;
    setCrunching(true);
    await new Promise((r) => setTimeout(r, 50));

    const baseSport =
      overrides?.sport ?? (sport === "auto" ? "ALL" : sport);
    const optionsForSizing = { sport: baseSport, realProjections: byProp };
    const resolved = {
      lineupCount:
        overrides?.count ??
        (lineupCount === "auto" ? AUTO_COUNT_DEFAULT : lineupCount),
      lineupSize:
        overrides?.size ??
        (lineupSize === "auto" ? pickAutoSize(board.props, optionsForSizing) : lineupSize),
      entry:
        overrides?.entry ??
        (entry === "auto" ? AUTO_ENTRY_DEFAULT : entry),
      sport: baseSport,
    };

    const r = buildAutoLineups(
      board.props,
      resolved.lineupSize,
      resolved.lineupCount,
      resolved.entry,
      { sport: resolved.sport, realProjections: byProp },
    );
    setResult(r);
    setResolvedParams(resolved);
    setCrunching(false);
    return { resolved, result: r };
  };

  const handleGenerate = () => runGenerate();

  /**
   * Chat send — parse natural language, mirror the parsed values into the
   * visible control state (so the user sees what we understood), then run
   * the generator with those same values as explicit overrides. The
   * overrides matter because React state updates above don't flush before
   * we call runGenerate, so without them we'd race.
   *
   * When the user has an Anthropic key set in Settings, the message is
   * sent to /api/chat first — Claude's reply text replaces the local
   * summary, and Claude's structured `intent` replaces the regex parse.
   * When the API call fails (or no key), we fall back to the regex parser
   * so the chat keeps working offline.
   */
  const handleChatSend = async () => {
    if (!board || crunching) return;
    const text = chatDraft.trim();
    if (!text) return;
    setChatDraft("");
    setChatMessages((m) => [...m, { role: "user", text }]);

    const knownSports = (board.leagues ?? []).map((l) => l.name);
    let parsed = parseRequest(text, knownSports);
    let claudeReply: string | null = null;

    // Pending bubble while we crunch — replaced once the optimizer returns.
    const placeholderIdx = chatMessages.length + 1;
    setChatMessages((m) => [
      ...m,
      {
        role: "assistant",
        text: anthropicKey ? "Thinking..." : "On it — checking the board...",
      },
    ]);

    // Try Claude when a key is set. Local parse stays as the fallback so
    // a 5xx from the API doesn't break the chat.
    if (anthropicKey) {
      try {
        const recent = chatMessages.slice(-6).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.text,
        }));
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: anthropicKey,
            message: text,
            history: recent,
            knownSports,
          }),
        });
        if (r.ok) {
          const data = (await r.json()) as {
            reply?: string;
            intent?: {
              count?: number;
              size?: number;
              entry?: number;
              sport?: string;
              mode?: "safe" | "balanced" | "aggressive";
              resetAll?: boolean;
            };
          };
          if (data.reply) claudeReply = data.reply;
          if (data.intent) {
            // Convert Claude's loose intent to ParsedRequest shape. matched[]
            // drives the reply summary — only mention fields the model
            // actually set.
            const i = data.intent;
            const matched: ParsedRequest["matched"] = [];
            const next: ParsedRequest = { matched };
            if (i.count !== undefined) {
              next.count = i.count;
              matched.push("count");
            }
            if (i.size !== undefined) {
              next.size = i.size;
              matched.push("size");
            }
            if (i.entry !== undefined) {
              next.entry = i.entry;
              matched.push("entry");
            }
            if (i.sport !== undefined) {
              next.sport = i.sport;
              matched.push("sport");
            }
            if (i.mode !== undefined) {
              next.mode = i.mode;
              matched.push("mode");
            }
            if (i.resetAll) {
              next.resetAll = true;
              matched.push("resetAll");
            }
            parsed = next;
          }
        }
      } catch {
        // Network/parse failure — keep the local regex parse we computed
        // up top, plus null claudeReply, so the assistant falls back to
        // the canned summary copy. Nothing else to do.
      }
    }

    // Mirror each matched value into the visible control state. Unmatched
    // values are left alone so the user's prior selections persist between
    // chat turns. Reset-all phrasings ("surprise me", "anything") drop
    // every knob back to Auto.
    if (parsed.resetAll) {
      setLineupCount("auto");
      setLineupSize("auto");
      setEntry("auto");
      setSport("auto");
    }
    if (parsed.count != null) setLineupCount(parsed.count);
    if (parsed.size != null) setLineupSize(parsed.size);
    if (parsed.entry != null) setEntry(parsed.entry);
    if (parsed.sport != null) setSport(parsed.sport);

    // Build overrides explicitly so runGenerate doesn't fall back to stale
    // React state. When the user said "surprise me", we pass the Auto
    // defaults straight through instead of relying on the just-set state.
    const overrides: Partial<{ count: number; size: number; entry: number; sport: string }> = {};
    if (parsed.resetAll) {
      overrides.count = AUTO_COUNT_DEFAULT;
      overrides.entry = AUTO_ENTRY_DEFAULT;
      overrides.sport = "ALL";
      // size: leave undefined so runGenerate's pickAutoSize kicks in
    }
    if (parsed.count != null) overrides.count = parsed.count;
    if (parsed.size != null) overrides.size = parsed.size;
    if (parsed.entry != null) overrides.entry = parsed.entry;
    if (parsed.sport != null) overrides.sport = parsed.sport;

    const out = await runGenerate(overrides);
    if (!out) {
      setChatMessages((m) =>
        m.map((msg, i) =>
          i === placeholderIdx
            ? { role: "assistant", text: "I can't reach the board right now — try again in a sec." }
            : msg,
        ),
      );
      return;
    }
    const reply = composeAssistantReply(text, parsed, out.resolved, out.result, claudeReply);
    setChatMessages((m) =>
      m.map((msg, i) => (i === placeholderIdx ? reply : msg)),
    );
  };

  // Push the generated lineups into the slip store and jump to the
  // leaderboard view — same shape the Optimizer page uses, so /slips
  // renders them without any special-casing.
  const handleSendToSlips = () => {
    if (!result || result.lineups.length === 0 || !resolvedParams) return;
    setLineupResults({
      lineups: result.lineups,
      totalGenerated: result.totalEvaluated,
      elapsedMs: result.elapsedMs,
      params: {
        lineupSize: resolvedParams.lineupSize,
        playType: result.lineups[0]?.playType ?? "power",
        entryCost: resolvedParams.entry,
        riskMode: "safe",
      },
    });
    router.push("/slips");
  };

  // ── Loading / error gates ─────────────────────────────────────────────────
  if (loadingBoard) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-32 text-center">
        <Loader2 size={48} className="text-[#FF3AF2] animate-spin mx-auto" strokeWidth={3} />
        <p className="mt-6 text-white/60 uppercase tracking-widest font-bold text-xs">
          Pulling live PrizePicks board...
        </p>
      </div>
    );
  }

  if (boardError) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <AlertTriangle size={48} className="text-[#F87171] mx-auto" strokeWidth={3} />
        <h1 className="font-[family-name:var(--font-heading)] font-black text-4xl mt-4 text-white">
          Couldn&apos;t reach the board
        </h1>
        <p className="text-white/60 mt-3 text-sm">{boardError}</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      {/* ════════════════════════════════════════════════════════════
          HERO
          ════════════════════════════════════════════════════════════ */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h1 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow">
          Auto-Pilot
        </h1>
        <p className="text-white/70 text-lg mt-3 max-w-3xl">
          No bench needed. Tell us how many lineups you want, we&apos;ll comb the entire
          live board for the highest-probability picks and hand you back ready-to-play slips.
        </p>
        <p className="text-white/40 text-xs mt-2 uppercase tracking-widest font-bold max-w-3xl">
          {filteredCount.toLocaleString()} props in pool ·
          {result && result.realProjectionCount > 0 ? (
            <>
              {" "}<span className="text-[#4ADE80]">{result.realProjectionCount} backed by real game-log Edge</span> ·
              rest use PrizePicks-implied odds
            </>
          ) : (
            <> uses PrizePicks-implied odds (visit live board first to seed real Edge data)</>
          )}
        </p>
      </motion.div>

      {/* ════════════════════════════════════════════════════════════
          CHAT — natural-language entry
          Users can just describe what they want: "I have $5, give me the
          best lineup to easily win." We parse, run the optimizer, grade
          the top result, and reply inline.
          ════════════════════════════════════════════════════════════ */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.03 }}
        className="mt-8 rounded-3xl border-4 border-[#00F5D4] bg-gradient-to-br from-[#00F5D4]/10 via-[#7B2FFF]/10 to-[#FF3AF2]/10 backdrop-blur-sm overflow-hidden"
        aria-label="Chat with Auto-Pilot"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3 border-b-4 border-dashed border-[#00F5D4]/30 flex-wrap">
          <div className="w-10 h-10 rounded-2xl border-4 border-[#00F5D4] bg-[#00F5D4] text-[#0D0D1A] flex items-center justify-center flex-shrink-0">
            <MessageCircle size={18} strokeWidth={3} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm md:text-base text-white">
              Just tell me what you want
            </h2>
            <p className="text-white/55 text-[11px] mt-0.5">
              {anthropicKey
                ? "Powered by Claude — ask anything, I'll grade what I build."
                : "Local parser — add a Claude key in Settings for real conversation."}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1 rounded-full border-2 text-[10px] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest",
              anthropicKey
                ? "border-[#4ADE80] text-[#4ADE80] bg-[#4ADE80]/10"
                : "border-white/30 text-white/50",
            )}
            title={anthropicKey ? "Anthropic API key found in Settings" : "No Anthropic key — using local parser"}
          >
            <Sparkles size={11} strokeWidth={3} />
            {anthropicKey ? "Claude on" : "Local"}
          </span>
          {!anthropicKey && (
            <Link
              href="/settings"
              className="text-[10px] font-bold uppercase tracking-widest text-[#00F5D4] hover:underline"
            >
              Add key →
            </Link>
          )}
        </div>

        {/* Conversation thread — collapses when empty so the panel stays
            compact for first-time users. Auto-scrolls down on new turns
            via the inner ChatThread component. */}
        {chatMessages.length > 0 && (
          <ChatThread messages={chatMessages} entry={resolvedParams?.entry ?? 20} />
        )}

        {/* Input + send */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleChatSend();
          }}
          className="p-3 md:p-4 flex items-stretch gap-2 md:gap-3"
        >
          <input
            type="text"
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            placeholder='Try "I have $5, give me the best lineup to easily win"'
            disabled={crunching || !board}
            aria-label="Chat with Auto-Pilot"
            className="flex-1 min-w-0 h-12 md:h-14 rounded-full border-4 border-[#00F5D4] bg-[#0D0D1A]/60 px-5 font-bold text-white placeholder:text-white/40 focus:outline-none focus:border-[#FFE600] focus:ring-4 focus:ring-[#00F5D4]/30 transition-all"
          />
          <button
            type="submit"
            disabled={crunching || !board || !chatDraft.trim()}
            className="h-12 md:h-14 px-5 md:px-6 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-xs md:text-sm flex items-center gap-2 hover:scale-105 active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {crunching ? (
              <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                <Loader2 size={16} strokeWidth={3} />
              </motion.span>
            ) : (
              <Send size={16} strokeWidth={3} />
            )}
            <span className="hidden sm:inline">Send</span>
          </button>
        </form>

        {/* Example prompts — only shown when the thread is empty. Click
            populates the input so users learn what phrasings work. */}
        {chatMessages.length === 0 && (
          <div className="px-4 pb-4 flex flex-wrap gap-2">
            {[
              "I have $5, give me the best lineup to easily win",
              "Build me 3 NBA slips for $20",
              "Surprise me",
              "One safe 4-pick",
            ].map((s) => (
              <button
                key={s}
                onClick={() => setChatDraft(s)}
                className="px-3 py-1.5 rounded-full border-2 border-dashed border-white/25 text-white/65 hover:text-white hover:border-white/50 text-[11px] font-bold uppercase tracking-widest transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </motion.section>

      {/* ════════════════════════════════════════════════════════════
          MASTER "ALL AUTO" CTA
          The fastest path through this page: leave every knob on Auto and
          hit the button. The card calls that out at the top, and when the
          user IS in all-auto state we show a "live" highlight so they know.
          ════════════════════════════════════════════════════════════ */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className={cn(
          "mt-4 rounded-3xl border-4 p-4 md:p-5 flex flex-wrap items-center gap-4 transition-colors",
          allAuto
            ? "border-[#FFE600] bg-gradient-to-r from-[#FF3AF2]/20 via-[#7B2FFF]/20 to-[#00F5D4]/20"
            : "border-dashed border-white/20 bg-[#2D1B4E]/30",
        )}
      >
        <div
          className={cn(
            "w-12 h-12 rounded-2xl border-4 flex items-center justify-center flex-shrink-0",
            allAuto ? "border-[#FFE600] bg-[#FFE600] text-[#0D0D1A]" : "border-[#FFE600]/60 text-[#FFE600]",
          )}
        >
          <Wand2 size={20} strokeWidth={3} />
        </div>
        <div className="flex-1 min-w-[200px]">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm md:text-base text-white">
            {allAuto ? "All auto — just hit the button" : "Or skip the decisions"}
          </div>
          <div className="text-white/65 text-xs mt-0.5">
            {allAuto
              ? "We'll choose the count, size, sport, and entry for you."
              : "Set every control to Auto and we'll pick the best of everything."}
          </div>
        </div>
        <button
          onClick={setAllAuto}
          disabled={allAuto}
          className={cn(
            "px-5 py-3 rounded-full border-4 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest transition-all",
            allAuto
              ? "border-[#FFE600]/40 text-[#FFE600]/50 cursor-default"
              : "border-[#FFE600] text-[#FFE600] hover:bg-[#FFE600]/10",
          )}
        >
          {allAuto ? "All auto ✓" : "Set all to Auto"}
        </button>
      </motion.div>

      {/* ════════════════════════════════════════════════════════════
          CONTROLS
          ════════════════════════════════════════════════════════════ */}
      <div className="grid lg:grid-cols-[1fr_360px] gap-8 mt-6">
        <div className="space-y-5">
          <ControlCard title="How many lineups?" icon={Trophy} accent="#FFE600" accent2="#FF3AF2">
            <div className="flex flex-wrap gap-3 items-center">
              <AutoPill
                active={lineupCount === "auto"}
                accent="#FFE600"
                onClick={() => setLineupCount("auto")}
              />
              {LINEUP_COUNTS.map((n) => (
                <button
                  key={n}
                  onClick={() => setLineupCount(n)}
                  className={cn(
                    "w-14 h-14 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black text-xl transition-all",
                    n === lineupCount
                      ? "bg-[#FFE600] border-[#FF3AF2] text-[#0D0D1A] shadow-[3px_3px_0_#FF3AF2]"
                      : "border-[#FFE600] text-[#FFE600] hover:bg-[#FFE600]/10",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="text-white/55 text-xs mt-3">
              {lineupCount === "auto" ? (
                <>Auto — we&apos;ll give you {AUTO_COUNT_DEFAULT} distinct slips.</>
              ) : (
                <>
                  We&apos;ll return your top {lineupCount}{" "}
                  {lineupCount === 1 ? "slip" : "slips"} — distinct picks where possible.
                </>
              )}
            </p>
          </ControlCard>

          <ControlCard title="Picks per lineup" icon={Layers} accent="#00F5D4" accent2="#7B2FFF">
            <div className="flex flex-wrap gap-3 items-center">
              <AutoPill
                active={lineupSize === "auto"}
                accent="#00F5D4"
                onClick={() => setLineupSize("auto")}
              />
              {LINEUP_SIZES.map((s) => (
                <button
                  key={s}
                  onClick={() => setLineupSize(s)}
                  className={cn(
                    "w-14 h-14 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black text-xl transition-all",
                    s === lineupSize
                      ? "bg-[#00F5D4] border-[#FF3AF2] text-[#0D0D1A] shadow-[3px_3px_0_#FF3AF2]"
                      : "border-[#00F5D4] text-[#00F5D4] hover:bg-[#00F5D4]/10",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="text-white/55 text-xs mt-3">
              {lineupSize === "auto" ? (
                <>Auto — we&apos;ll sweep 2–6 picks and pick the size with the highest avg $.</>
              ) : (
                <>
                  Smaller slips hit more often but pay less. {lineupSize}-pick base payout:{" "}
                  <span className="text-[#FFE600] font-bold">
                    {POWER_BASE[lineupSize as keyof typeof POWER_BASE] ?? "—"}×
                  </span>{" "}
                  on Power.
                </>
              )}
            </p>
          </ControlCard>

          <ControlCard title="Entry cost" icon={TrendingUp} accent="#FF6B35" accent2="#FFE600">
            <div className="flex flex-wrap gap-3 items-center">
              <AutoPill
                active={entry === "auto"}
                accent="#FF6B35"
                onClick={() => setEntry("auto")}
              />
              {ENTRY_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setEntry(p)}
                  className={cn(
                    "px-5 h-12 rounded-full border-4 font-[family-name:var(--font-heading)] font-black text-lg transition-all",
                    p === entry
                      ? "bg-[#FF6B35] border-[#FFE600] text-[#0D0D1A] shadow-[2px_2px_0_#FFE600]"
                      : "border-[#FF6B35] text-[#FF6B35] hover:bg-[#FF6B35]/15",
                  )}
                >
                  ${p}
                </button>
              ))}
              <input
                type="number"
                value={entry === "auto" ? "" : entry}
                placeholder={entry === "auto" ? `$${AUTO_ENTRY_DEFAULT}` : undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setEntry("auto");
                    return;
                  }
                  setEntry(Math.max(1, Math.min(1000, Number(v) || 0)));
                }}
                className="w-20 h-12 rounded-full border-4 border-dashed border-[#FFE600] bg-transparent px-3 font-[family-name:var(--font-heading)] font-black text-center text-white placeholder:text-white/30 focus:outline-none focus:bg-[#FFE600]/10"
              />
            </div>
            {entry === "auto" && (
              <p className="text-white/55 text-xs mt-3">
                Auto — defaults to ${AUTO_ENTRY_DEFAULT} per slip.
              </p>
            )}
          </ControlCard>

          {leagueOptions.length > 1 && (
            <ControlCard title="Sport filter" icon={Filter} accent="#7B2FFF" accent2="#00F5D4">
              <div className="flex flex-wrap gap-2 items-center">
                <AutoPill
                  active={sport === "auto"}
                  accent="#7B2FFF"
                  onClick={() => setSport("auto")}
                />
                {leagueOptions.map((lg, i) => {
                  const active = sport === lg.name;
                  const accent = accentHexFor(i);
                  return (
                    <button
                      key={lg.name}
                      onClick={() => setSport(lg.name)}
                      className={cn(
                        "px-3 py-2 rounded-full border-[3px] font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-wider transition-all flex items-center gap-1.5",
                        active ? "text-[#0D0D1A]" : "text-white hover:scale-105",
                      )}
                      style={{
                        borderColor: accent,
                        background: active ? accent : "transparent",
                      }}
                    >
                      {lg.name}
                      <span className="text-[10px] opacity-70 font-bold">{lg.count}</span>
                    </button>
                  );
                })}
              </div>
              {sport === "auto" && (
                <p className="text-white/55 text-xs mt-3">
                  Auto — no sport filter, pulls from every league on the board.
                </p>
              )}
            </ControlCard>
          )}
        </div>

        {/* ── Sticky generate panel ── */}
        <aside>
          <div className="sticky top-24 space-y-4">
            <motion.div
              key={`${lineupCount}-${lineupSize}-${entry}`}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="rounded-3xl border-4 border-[#FFE600] bg-gradient-to-br from-[#FF3AF2]/30 via-[#7B2FFF]/30 to-[#00F5D4]/30 backdrop-blur-sm p-6"
            >
              <div className="text-white/70 text-[10px] uppercase tracking-widest font-bold">
                You&apos;ll get back
              </div>
              <div className="font-[family-name:var(--font-display)] text-6xl text-[#FFE600] leading-none mt-1 text-shadow-2 flex items-baseline gap-2">
                {lineupCount === "auto" ? AUTO_COUNT_DEFAULT : lineupCount}
                {lineupCount === "auto" && (
                  <span className="font-[family-name:var(--font-heading)] text-xs uppercase tracking-widest text-[#FFE600]/80 font-black">
                    auto
                  </span>
                )}
              </div>
              <div className="text-white/70 text-xs mt-2">
                slips ·{" "}
                {lineupSize === "auto" ? (
                  <span className="text-[#00F5D4] font-bold">auto</span>
                ) : (
                  lineupSize
                )}{" "}
                picks each ·{" "}
                {entry === "auto" ? (
                  <span className="text-[#FF6B35] font-bold">auto</span>
                ) : (
                  <>${entry}</>
                )}{" "}
                entry
              </div>
              <div className="text-white/50 text-[10px] uppercase tracking-widest font-bold mt-3">
                Sport ·{" "}
                {sport === "auto" ? (
                  <span className="text-[#7B2FFF]">auto</span>
                ) : (
                  sport
                )}
              </div>
            </motion.div>

            <button
              onClick={handleGenerate}
              disabled={crunching || !board}
              className={cn(
                "w-full h-16 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4]",
                "font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-lg",
                "flex items-center justify-center gap-3 transition-all",
                "hover:scale-105 active:scale-95",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
                !crunching && board && "animate-(--animate-pulse-glow)",
              )}
            >
              {crunching ? (
                <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                  <Sliders size={22} strokeWidth={3} />
                </motion.span>
              ) : allAuto ? (
                <Wand2 size={22} strokeWidth={3} />
              ) : (
                <Sparkles size={22} strokeWidth={3} />
              )}
              {crunching
                ? "Hunting picks..."
                : allAuto
                  ? "Surprise me"
                  : "Build my lineups"}
            </button>
            <p className="text-center text-white/50 text-xs">
              Ranked by chance to hit · ties broken by avg $ per play.
            </p>
          </div>
        </aside>
      </div>

      {/* ════════════════════════════════════════════════════════════
          RESULTS
          ════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {result && (
          <motion.section
            key="results"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", damping: 22 }}
            className="mt-14"
          >
            <div className="flex items-end justify-between flex-wrap gap-3 mb-6">
              <div>
                <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-4xl md:text-5xl gradient-text-rainbow">
                  Your auto-picks
                </h2>
                <p className="text-white/55 text-xs mt-2 uppercase tracking-widest font-bold">
                  {result.totalEvaluated.toLocaleString()} combos evaluated in {result.elapsedMs}ms ·
                  pool of {result.poolSize} props
                  {result.realProjectionCount > 0 ? (
                    <> · <span className="text-[#4ADE80]">{result.realProjectionCount} real Edge</span></>
                  ) : null}
                </p>
              </div>
              {result.lineups.length > 0 && (
                <button
                  onClick={handleSendToSlips}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-full border-4 border-[#00F5D4] bg-gradient-to-r from-[#00F5D4] via-[#7B2FFF] to-[#FF3AF2] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-sm hover:scale-105 active:scale-95 transition-transform"
                >
                  Open in leaderboard
                  <ArrowRight size={16} strokeWidth={3} />
                </button>
              )}
            </div>

            {/* "We chose" summary — only shown when at least one knob was on
                Auto, so the user sees what the algorithm resolved each
                auto-value to without having to scroll back up. */}
            {resolvedParams && (
              <ResolvedSummary
                resolved={resolvedParams}
                wasAuto={{
                  count: lineupCount === "auto",
                  size: lineupSize === "auto",
                  entry: entry === "auto",
                  sport: sport === "auto",
                }}
              />
            )}

            {result.lineups.length === 0 ? (
              <EmptyResult
                lineupSize={resolvedParams?.lineupSize ?? 4}
                pool={result.poolSize}
                sport={resolvedParams?.sport ?? "ALL"}
              />
            ) : (
              <div className="grid gap-5">
                {result.lineups.map((l, i) => (
                  <LineupCard
                    key={l.id}
                    lineup={l}
                    index={i}
                    entry={resolvedParams?.entry ?? l.entryCost}
                  />
                ))}
              </div>
            )}

            {/* Honest disclosure — these aren't guaranteed, they're highest-probability. */}
            <div className="mt-8 rounded-2xl border-2 border-dashed border-[#FFE600]/40 bg-[#FFE600]/5 p-4 text-white/65 text-xs leading-relaxed">
              <strong className="text-[#FFE600] uppercase tracking-widest text-[10px] font-bold block mb-1.5">
                One thing
              </strong>
              No bet is guaranteed — PrizePicks tunes their lines so house edge holds in the long
              run. We&apos;re showing the lineups with the highest chance to hit given the data we have
              (real game-log projections when cached, PrizePicks-implied otherwise). Visit the
              Live Board first to seed real Edge data for the leagues you want stronger picks in.
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Internal components
// ══════════════════════════════════════════════════════════════════════

const POWER_BASE: Record<number, number> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 25,
};

/**
 * Auto pill — the "AUTO" chip that lives at the head of every control row.
 * Active state matches the card's accent color so it reads as one of the
 * options, not a separate widget.
 */
function AutoPill({
  active,
  accent,
  onClick,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Let us pick this for you"
      className={cn(
        "h-12 px-4 rounded-2xl border-4 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest transition-all flex items-center gap-1.5",
        active ? "shadow-[3px_3px_0_#FF3AF2]" : "hover:opacity-90",
      )}
      style={{
        borderColor: active ? "#FF3AF2" : accent,
        background: active ? accent : "transparent",
        color: active ? "#0D0D1A" : accent,
      }}
    >
      <Wand2 size={13} strokeWidth={3} />
      Auto
    </button>
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

function LineupCard({
  lineup,
  index,
  entry,
}: {
  lineup: import("@/lib/types").Lineup;
  index: number;
  entry: number;
}) {
  const accent = accentHexFor(index);
  const accent2 = accentHexFor(index + 2);
  const pctColor =
    lineup.hitProbability >= 0.25
      ? "#4ADE80"
      : lineup.hitProbability >= 0.10
        ? "#FFE600"
        : "#F87171";
  const evColor = lineup.expectedValue >= 0 ? "#4ADE80" : "#F87171";

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", damping: 22, delay: index * 0.04 }}
      className="rounded-3xl border-4 bg-[#0D0D1A]/70 backdrop-blur-sm overflow-hidden"
      style={{ borderColor: accent, boxShadow: `5px 5px 0 ${accent2}` }}
    >
      {/* Header — title row, then a stat strip below. On desktop the
          stat strip flattens into one row via `md:contents`, which lets the
          title and stats sit on the same grid line. */}
      <div
        className="grid gap-3 md:gap-5 p-5 items-center border-b-4 border-dashed md:grid-cols-[auto_1fr_auto_auto_auto]"
        style={{ borderColor: `${accent}55` }}
      >
        <div className="flex items-center gap-3 md:contents">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center font-[family-name:var(--font-display)] text-2xl text-[#0D0D1A] flex-shrink-0"
            style={{ background: accent }}
          >
            #{index + 1}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-xs text-white/55">
              {lineup.picks.length}-pick · {lineup.playType === "power" ? "Power (all hit)" : "Flex (partial OK)"}
            </div>
            <div className="text-white text-sm mt-0.5">
              {lineup.payoutMultiplier.toFixed(2)}× payout · pays{" "}
              <span className="text-[#00F5D4] font-bold">${lineup.grossPayout.toFixed(0)}</span> if it lands
            </div>
          </div>
        </div>

        {/* Mobile: 3-column stat strip below the title. Desktop: each Stat
            lands in its own grid column thanks to the `md:contents` above. */}
        <div className="grid grid-cols-3 gap-2 md:contents">
          <Stat label="Hit %" accent={pctColor}>
            <AnimatedPercent value={lineup.hitProbability} decimals={1} className="font-[family-name:var(--font-display)] text-2xl md:text-4xl leading-none" />
          </Stat>
          <Stat label="Avg $" accent={evColor}>
            <span style={{ color: evColor }} className="font-[family-name:var(--font-display)] text-2xl md:text-4xl leading-none">
              {lineup.expectedValue >= 0 ? "+" : ""}${lineup.expectedValue.toFixed(2)}
            </span>
          </Stat>
          <Stat label="Pays" accent="#FFE600">
            <span className="font-[family-name:var(--font-display)] text-2xl md:text-4xl text-white leading-none">
              ${lineup.grossPayout.toFixed(0)}
            </span>
          </Stat>
        </div>
      </div>

      {/* Picks */}
      <ul className="grid gap-2 p-5">
        {lineup.picks.map((p, i) => {
          const isMore = p.side === "more";
          const sideColor = isMore ? "#4ADE80" : "#F87171";
          const SideIcon = isMore ? TrendingUp : TrendingDown;
          return (
            <li
              key={p.prop.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-white/10 bg-[#2D1B4E]/40 px-3 py-2.5"
            >
              <span
                className="w-7 h-7 rounded-full border-2 flex items-center justify-center font-[family-name:var(--font-display)] text-xs text-white/85"
                style={{ borderColor: sideColor }}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tight text-white text-sm md:text-base leading-tight">
                  {p.prop.playerName}
                </div>
                <div className="text-white/55 text-[10px] md:text-[11px] uppercase tracking-widest font-bold flex items-center gap-1 md:gap-1.5 flex-wrap mt-0.5">
                  <span>{p.prop.statType}</span>
                  <span>·</span>
                  <span className="text-white/75">{isMore ? "More" : "Less"} {p.prop.line}</span>
                  <span className="hidden md:inline">·</span>
                  <span className="hidden md:inline">{p.prop.sport}</span>
                  {p.prop.oddsType !== "standard" && (
                    <>
                      <span>·</span>
                      <OddsBadge oddsType={p.prop.oddsType} compact />
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px]"
                  style={{ backgroundColor: `${sideColor}20`, color: sideColor, border: `1px solid ${sideColor}` }}
                >
                  <SideIcon size={11} strokeWidth={3} />
                  {isMore ? "More" : "Less"}
                </span>
                <span
                  className="font-[family-name:var(--font-display)] text-lg w-12 text-right"
                  style={{ color: sideColor }}
                >
                  {(p.probability * 100).toFixed(0)}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="px-5 pb-5 text-white/45 text-[10px] uppercase tracking-widest font-bold">
        Entry ${entry} · {lineup.correlationRisk === "low" ? "picks independent" : lineup.correlationRisk === "medium" ? "some overlap" : "lots of overlap"}
      </div>
    </motion.article>
  );
}

function Stat({
  label,
  accent,
  children,
}: {
  label: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="text-center">
      <div
        className="text-[9px] uppercase tracking-widest font-bold mb-1"
        style={{ color: accent }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * Compact strip shown above the lineup list whenever any control was on
 * Auto. Each chip shows the resolved value with a wand icon on the ones
 * that were actually chosen by the algorithm. When nothing was on auto,
 * the parent simply doesn't render this.
 */
function ResolvedSummary({
  resolved,
  wasAuto,
}: {
  resolved: { lineupCount: number; lineupSize: number; entry: number; sport: string };
  wasAuto: { count: boolean; size: boolean; entry: boolean; sport: boolean };
}) {
  const anyAuto = wasAuto.count || wasAuto.size || wasAuto.entry || wasAuto.sport;
  if (!anyAuto) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6 rounded-2xl border-2 border-dashed border-[#FFE600]/40 bg-[#FFE600]/5 p-3 md:p-4 flex flex-wrap items-center gap-2 md:gap-3"
    >
      <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px] text-[#FFE600] flex items-center gap-1.5">
        <Wand2 size={12} strokeWidth={3} />
        We chose
      </span>
      <ResolvedChip label={`${resolved.lineupCount} ${resolved.lineupCount === 1 ? "slip" : "slips"}`} auto={wasAuto.count} accent="#FFE600" />
      <ResolvedChip label={`${resolved.lineupSize}-pick`} auto={wasAuto.size} accent="#00F5D4" />
      <ResolvedChip label={`$${resolved.entry}`} auto={wasAuto.entry} accent="#FF6B35" />
      <ResolvedChip label={resolved.sport === "ALL" ? "All sports" : resolved.sport} auto={wasAuto.sport} accent="#7B2FFF" />
    </motion.div>
  );
}

function ResolvedChip({
  label,
  auto,
  accent,
}: {
  label: string;
  auto: boolean;
  accent: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 font-[family-name:var(--font-heading)] font-black uppercase text-[10px] tracking-widest"
      style={{
        borderColor: accent,
        color: auto ? "#0D0D1A" : accent,
        background: auto ? accent : "transparent",
      }}
    >
      {auto && <Wand2 size={10} strokeWidth={3} />}
      {label}
    </span>
  );
}

/**
 * Scroll-pinned chat transcript. Each turn is one user bubble or one
 * assistant bubble; assistant bubbles that produced a lineup also render
 * a compact preview card with the grade, hit %, and picks.
 *
 * Auto-scrolls to the bottom whenever new messages arrive so the latest
 * reply is always visible without manual scrolling.
 */
function ChatThread({
  messages,
  entry,
}: {
  messages: ChatMessage[];
  entry: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  return (
    <div
      ref={scrollRef}
      className="max-h-[420px] overflow-y-auto px-4 md:px-5 py-4 space-y-3 border-b-4 border-dashed border-[#00F5D4]/30"
    >
      <AnimatePresence initial={false}>
        {messages.map((m, i) => (
          <ChatBubble key={i} message={m} entry={entry} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ChatBubble({ message, entry }: { message: ChatMessage; entry: number }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", damping: 22 }}
      className={cn("flex", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-3xl px-4 py-2.5 border-2",
          isUser
            ? "bg-gradient-to-r from-[#FF3AF2] to-[#7B2FFF] border-[#FFE600] text-white rounded-br-md"
            : "bg-[#0D0D1A]/70 border-[#00F5D4]/60 text-white rounded-bl-md",
        )}
      >
        <p className="text-sm leading-snug">{message.text}</p>
        {message.preview && <LineupPreview preview={message.preview} entry={entry} />}
      </div>
    </motion.div>
  );
}

/**
 * Compact lineup preview rendered inside an assistant bubble. Shows the
 * letter grade, hit %, and a stack of the picks so the user can read it
 * without scrolling down to the main results section.
 */
function LineupPreview({
  preview,
  entry,
}: {
  preview: NonNullable<ChatMessage["preview"]>;
  entry: number;
}) {
  const evColor = preview.expectedValue >= 0 ? "#4ADE80" : "#F87171";
  const gradeColor = GRADE_COLOR[preview.grade];
  return (
    <div className="mt-3 rounded-2xl border-2 border-[#00F5D4]/40 bg-[#0D0D1A]/60 p-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center font-[family-name:var(--font-display)] text-3xl text-[#0D0D1A] flex-shrink-0"
          style={{ background: gradeColor }}
          aria-label={`Grade ${preview.grade}`}
        >
          {preview.grade}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-[10px] text-white/55">
            {preview.size}-pick {preview.playType === "power" ? "Power" : "Flex"} · ${preview.entry || entry} entry
          </div>
          <div className="flex items-baseline gap-3 mt-0.5 flex-wrap">
            <span className="font-[family-name:var(--font-display)] text-2xl text-[#FFE600] leading-none">
              {(preview.hitProb * 100).toFixed(1)}%
            </span>
            <span className="text-[10px] uppercase tracking-widest font-bold text-white/60">
              chance to hit
            </span>
          </div>
          <div className="flex items-baseline gap-2 mt-1 text-xs flex-wrap">
            <span style={{ color: evColor }} className="font-bold">
              {preview.expectedValue >= 0 ? "+" : ""}${preview.expectedValue.toFixed(2)} avg
            </span>
            <span className="text-white/40">·</span>
            <span className="text-[#00F5D4] font-bold">${preview.grossPayout.toFixed(0)} if it hits</span>
          </div>
        </div>
      </div>
      <ul className="mt-3 space-y-1">
        {preview.picks.map((p, i) => {
          const isMore = p.side === "more";
          const sideColor = isMore ? "#4ADE80" : "#F87171";
          return (
            <li
              key={`${p.player}-${i}`}
              className="flex items-center gap-2 text-[11px]"
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-[family-name:var(--font-display)] flex-shrink-0"
                style={{ background: `${sideColor}30`, color: sideColor, border: `1px solid ${sideColor}` }}
              >
                {i + 1}
              </span>
              <span className="font-bold text-white truncate">{p.player}</span>
              <span className="text-white/55 truncate">
                {p.statType} {isMore ? "More" : "Less"} {p.line}
              </span>
            </li>
          );
        })}
      </ul>
      {preview.count > 1 && (
        <p className="mt-2 text-[10px] text-white/45 uppercase tracking-widest font-bold">
          + {preview.count - 1} more {preview.count - 1 === 1 ? "lineup" : "lineups"} below
        </p>
      )}
    </div>
  );
}

function EmptyResult({
  lineupSize,
  pool,
  sport,
}: {
  lineupSize: number;
  pool: number;
  sport: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="rounded-3xl border-4 border-dashed border-[#F87171] bg-[#F87171]/10 p-8 text-center"
    >
      <Zap size={36} className="text-[#F87171] mx-auto" strokeWidth={3} />
      <h3 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-lg text-white mt-3">
        No lineups available
      </h3>
      <p className="text-white/65 text-sm mt-2 max-w-md mx-auto">
        Pool of {pool} {sport === "ALL" ? "" : `${sport} `}props can&apos;t form a {lineupSize}-pick
        slip with two different teams. Try a different sport, a smaller lineup size, or wait
        for more games to come on the board.
      </p>
    </motion.div>
  );
}
