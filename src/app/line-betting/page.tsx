"use client";

/**
 * LINE BETTING — PrizePicks vs. the books.
 *
 * Every standard PrizePicks pick pays the same on More or Less, so PrizePicks
 * is pricing it as a coin flip. Sportsbooks and Kalshi aren't: the side they
 * charge more for is the side they think hits. This tab reads that lean, takes
 * that side, and deals it into 10 unique 3-pick Power Plays.
 * Data: /api/line-betting (see src/lib/lineShop/*).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowDownRight, ArrowUpRight, BookOpen, Check, Copy, Landmark, Loader2, RefreshCw,
  Scale, ShieldCheck, TriangleAlert, Zap, Brain, Fingerprint,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { Prop, PickSide } from "@/lib/types";

// ── Types (mirror /api/line-betting) ─────────────────────────────────────────
interface Source {
  kind: "book" | "kalshi" | "model";
  name: string; line: number; pOver: number; weight: number; exactLine: boolean;
  over?: number; under?: number; detail?: string;
}
interface Pick {
  id: string; prop: Prop; canon: string | null; uniqueKey: string; side: PickSide;
  p: number; pOver: number; tier: "market" | "model" | "none"; sources: Source[]; marketCount: number;
}
interface Lineup {
  rank: number; picks: Pick[]; hitProb: number; multiplier: number; evPerDollar: number;
  tier: Pick["tier"]; sameGame: boolean;
}
interface Payload {
  generatedAt: string;
  board: { error?: string; stale: boolean };
  sources: {
    sportsbooks: { configured: boolean; ok: boolean; quotes: number; books: string[]; requestsRemaining: number | null; error?: string };
    kalshi: { ok: boolean; seriesTracked: number; matched: number };
  };
  modelTrainedAt: string | null;
  coverage: { boardProps: number; eligible: number; marketPriced: number; modelPriced: number; bookMatched: number; kalshiMatched: number; aboveBreakeven: number };
  slate: {
    lineups: Lineup[]; requested: number; legs: number; multiplier: number; breakeven: number;
    uniquePicks: number; duplicateCheck: { repeatedKeys: string[] }; shortfall?: string;
  };
  bench: Pick[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;
const american = (n?: number) => (n == null ? "—" : n > 0 ? `+${n}` : `${n}`);
const BOOK_ABBR: Record<string, string> = {
  DraftKings: "DK", FanDuel: "FD", BetMGM: "MGM", Caesars: "CZR", "ESPN BET": "ESPN", Fanatics: "FAN",
  BetRivers: "BR", "Hard Rock Bet": "HR", Bovada: "BOV", BetOnline: "BOL", "BetOnline.ag": "BOL", LowVig: "LV", "LowVig.ag": "LV", MyBookie: "MYB", "MyBookie.ag": "MYB",
};
const abbr = (b: string) => BOOK_ABBR[b] ?? b.slice(0, 4).toUpperCase();

function ago(iso: string | null): string {
  if (!iso) return "never";
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${h.toFixed(0)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function gameLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function slipText(l: Lineup): string {
  const head = `EdgeBoard Line Betting · Power Play #${l.rank} (${l.multiplier}x)`;
  const rows = l.picks.map((p) => `${p.prop.playerName} ${p.side === "more" ? "MORE" : "LESS"} ${p.prop.line} ${p.prop.statType} (${pct(p.p)})`);
  return [head, ...rows, `Hit ${pct(l.hitProb)} · EV ${l.evPerDollar >= 0 ? "+" : ""}${l.evPerDollar.toFixed(2)}/$1`].join("\n");
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function StatTile({ label, value, sub, color, delay }: { label: string; value: string; sub?: string; color: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }}
      className="rounded-2xl border-4 bg-[#0D0D1A]/70 px-4 py-3"
      style={{ borderColor: color }}
    >
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-white/50">{label}</div>
      <div className="font-[family-name:var(--font-display)] text-4xl leading-none mt-1" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] text-white/50 mt-1">{sub}</div>}
    </motion.div>
  );
}

function SourceChip({ s, side }: { s: Source; side: PickSide }) {
  if (s.kind === "model") {
    const p = side === "more" ? s.pOver : 1 - s.pOver;
    return (
      <span title="EdgeBoard's trained model — shown for reference, not blended into the market price"
        className="inline-flex items-center gap-1 rounded-full border border-[#7B2FFF]/60 bg-[#7B2FFF]/10 px-2 py-0.5 text-[10px] font-bold text-[#C4A6FF]">
        <Brain size={10} /> {pct(p, 0)}
      </span>
    );
  }
  if (s.kind === "kalshi") {
    const p = side === "more" ? s.pOver : 1 - s.pOver;
    return (
      <span title={`Kalshi ${s.detail ?? ""}`}
        className="inline-flex items-center gap-1 rounded-full border border-[#00F5D4]/60 bg-[#00F5D4]/10 px-2 py-0.5 text-[10px] font-bold text-[#00F5D4]">
        <Landmark size={10} /> K {pct(p, 0)}
      </span>
    );
  }
  const price = side === "more" ? s.over : s.under;
  return (
    <span
      title={`${s.name}: Over ${american(s.over)} / Under ${american(s.under)} at ${s.line}${s.exactLine ? "" : " (line shifted to PrizePicks)"}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold",
        s.exactLine ? "border-[#FFE600]/60 bg-[#FFE600]/10 text-[#FFE600]" : "border-white/20 bg-white/5 text-white/60",
      )}
    >
      {abbr(s.name)} {american(price)}{!s.exactLine && <span className="opacity-70">@{s.line}</span>}
    </span>
  );
}

function SidePill({ side }: { side: PickSide }) {
  const more = side === "more";
  return (
    <span className={cn(
      "inline-flex items-center gap-0.5 rounded-lg px-2 py-1 font-[family-name:var(--font-heading)] font-black text-xs uppercase tracking-wider border-2",
      more ? "bg-[#4ADE80]/15 border-[#4ADE80] text-[#4ADE80]" : "bg-[#F87171]/15 border-[#F87171] text-[#F87171]",
    )}>
      {more ? <ArrowUpRight size={13} strokeWidth={3} /> : <ArrowDownRight size={13} strokeWidth={3} />}
      {more ? "More" : "Less"}
    </span>
  );
}

function PickRow({ p, breakeven }: { p: Pick; breakeven: number }) {
  const edge = p.p - breakeven;
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3">
      <div className="flex items-start gap-3">
        {p.prop.playerImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.prop.playerImage} alt="" className="w-10 h-10 rounded-full object-cover bg-white/10 shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#FF3AF2] to-[#7B2FFF] shrink-0 flex items-center justify-center font-black text-sm">
            {p.prop.playerName.slice(0, 1)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="font-[family-name:var(--font-heading)] font-black text-white truncate">{p.prop.playerName}</div>
            <SidePill side={p.side} />
          </div>
          <div className="text-xs text-white/60 mt-0.5">
            <span className="font-bold text-white">{p.prop.line}</span> {p.prop.statType}
            <span className="text-white/35"> · {p.prop.sport} · {p.prop.team}{p.prop.opponent ? ` vs ${p.prop.opponent}` : ""} · {gameLabel(p.prop.gameTime)}</span>
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden relative">
          <motion.div
            initial={{ width: 0 }} animate={{ width: `${Math.min(100, p.p * 100)}%` }} transition={{ duration: 0.8 }}
            className="h-full rounded-full"
            style={{ background: edge >= 0 ? "linear-gradient(90deg,#00F5D4,#4ADE80)" : "linear-gradient(90deg,#FF6B35,#FFE600)" }}
          />
          <div className="absolute top-0 bottom-0 w-0.5 bg-white/70" style={{ left: `${breakeven * 100}%` }} title={`Breakeven ${pct(breakeven)}`} />
        </div>
        <span className="font-[family-name:var(--font-display)] text-lg leading-none w-14 text-right" style={{ color: edge >= 0 ? "#4ADE80" : "#FFE600" }}>
          {pct(p.p)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {p.tier === "none" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-[#FF6B35] bg-[#FF6B35]/15 px-2 py-0.5 text-[10px] font-bold text-[#FF6B35]">
            <TriangleAlert size={10} /> No market price — filler
          </span>
        )}
        {p.tier === "model" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-[#7B2FFF] bg-[#7B2FFF]/15 px-2 py-0.5 text-[10px] font-bold text-[#C4A6FF]">
            Model only — no book/Kalshi line
          </span>
        )}
        {p.sources.map((s, i) => <SourceChip key={i} s={s} side={p.side} />)}
      </div>
    </div>
  );
}

const CARD_ACCENTS = ["#FF3AF2", "#00F5D4", "#FFE600", "#FF6B35", "#7B2FFF"];

function LineupCard({ l, breakeven, i }: { l: Lineup; breakeven: number; i: number }) {
  const [copied, setCopied] = useState(false);
  const accent = CARD_ACCENTS[i % CARD_ACCENTS.length];
  const plus = l.evPerDollar >= 0;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, rotate: i % 2 ? 0.6 : -0.6 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{ delay: 0.05 * i, type: "spring", damping: 18 }}
      className="relative rounded-3xl border-4 bg-[#141428]/90 p-4 md:p-5"
      style={{ borderColor: accent, boxShadow: `6px 6px 0 ${accent}55` }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div className="font-[family-name:var(--font-display)] text-5xl leading-none" style={{ color: accent }}>#{l.rank}</div>
          <div>
            <div className="flex items-center gap-1.5 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-sm text-white">
              <Zap size={14} className="text-[#FFE600]" strokeWidth={3} /> Power Play
            </div>
            <div className="text-[11px] text-white/50 uppercase tracking-widest font-bold">{l.picks.length} picks · {l.multiplier}× payout</div>
          </div>
        </div>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(slipText(l)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
          }}
          className="rounded-full border-2 border-white/20 p-2 text-white/60 hover:text-white hover:border-white/60 transition"
          aria-label="Copy lineup"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-xl bg-white/5 px-3 py-2">
          <div className="text-[9px] uppercase tracking-[0.2em] text-white/45 font-bold">Hit chance</div>
          <div className="font-[family-name:var(--font-display)] text-2xl text-white leading-none mt-0.5">{pct(l.hitProb)}</div>
        </div>
        <div className="rounded-xl px-3 py-2" style={{ background: plus ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)" }}>
          <div className="text-[9px] uppercase tracking-[0.2em] text-white/45 font-bold">Avg return / $1</div>
          <div className="font-[family-name:var(--font-display)] text-2xl leading-none mt-0.5" style={{ color: plus ? "#4ADE80" : "#F87171" }}>
            {plus ? "+" : ""}{l.evPerDollar.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {l.picks.map((p) => <PickRow key={p.id} p={p} breakeven={breakeven} />)}
      </div>

      {l.sameGame && (
        <div className="mt-2 text-[11px] text-[#FFE600]/80 flex items-center gap-1.5">
          <TriangleAlert size={12} /> Two legs share a game — outcomes are correlated, hit chance is approximate.
        </div>
      )}
    </motion.div>
  );
}

function JuiceExplainer({ breakeven, mult }: { breakeven: number; mult: number }) {
  // The user's own example: Over +113 / Under −98.
  const io = 100 / 213, iu = 98 / 198;
  const fairUnder = iu / (io + iu);
  return (
    <div className="rounded-3xl border-4 border-dashed border-[#00F5D4]/60 bg-[#00F5D4]/5 p-5">
      <div className="flex items-center gap-2 mb-2">
        <BookOpen size={16} className="text-[#00F5D4]" />
        <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm text-[#00F5D4]">How it reads the money</span>
      </div>
      <p className="text-sm text-white/75 leading-relaxed">
        A book posting <b className="text-white">Over +113 / Under −98</b>{" "}is saying the Under is more likely — you have to risk more to win on it.
        Strip out the book&apos;s cut and the Under is a <b className="text-[#4ADE80]">{pct(fairUnder)}</b> shot. PrizePicks pays More and Less the same, so
        we take the Under. A 3-pick Power Play at {mult}× only profits long-run when your picks average above <b className="text-[#FFE600]">{pct(breakeven)}</b> each —
        the white tick on every bar.
      </p>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function LineBettingPage() {
  const [mult, setMult] = useState<5 | 6>(6);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // State is only set after the await, so the mount effect never triggers a
  // synchronous re-render; the button flips `loading` itself before calling.
  const load = useCallback(async (m: number) => {
    try {
      const res = await fetch(`/api/line-betting?mult=${m}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Payload;
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred like the Live Board's loader, so no setState runs in the effect's sync phase.
    queueMicrotask(() => { void load(mult); });
  }, [load, mult]);

  const reshop = (m: 5 | 6) => {
    setLoading(true);
    if (m !== mult) setMult(m); else void load(m);
  };

  const avgLeg = useMemo(() => {
    const picks = data?.slate.lineups.flatMap((l) => l.picks) ?? [];
    return picks.length ? picks.reduce((a, p) => a + p.p, 0) / picks.length : 0;
  }, [data]);

  const slate = data?.slate;
  const books = data?.sources.sportsbooks;
  const repeats = slate?.duplicateCheck.repeatedKeys.length ?? 0;
  const weakLineups = slate?.lineups.filter((l) => l.tier !== "market").length ?? 0;

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <div className="flex items-center gap-2 text-[#00F5D4] text-xs font-bold uppercase tracking-[0.3em] mb-2">
          <Scale size={14} strokeWidth={3} /> PrizePicks × Sportsbooks × Kalshi
        </div>
        <h1 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow">
          Line Betting
        </h1>
        <p className="text-white/70 text-lg mt-3 max-w-2xl">
          Every pick cross-checked against real money lines. We take the side the market leans and deal it into
          {" "}<b className="text-white">10 Power Plays</b> — 30 picks, zero repeats.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-full border-4 border-[#FF3AF2] p-1 bg-[#0D0D1A]">
            {([6, 5] as const).map((m) => (
              <button key={m} onClick={() => reshop(m)}
                className={cn(
                  "px-4 py-1.5 rounded-full font-[family-name:var(--font-heading)] font-black uppercase text-sm tracking-wider transition",
                  mult === m ? "bg-[#FFE600] text-[#0D0D1A]" : "text-white/70 hover:text-white",
                )}
                title={m === 6 ? "3-pick Power Play pays 6×" : "Some states / promos pay 5× on 3-pick Power"}
              >
                {m}× payout
              </button>
            ))}
          </div>
          <button onClick={() => reshop(mult)} disabled={loading}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-sm hover:scale-105 active:scale-95 transition-transform disabled:opacity-60 disabled:hover:scale-100">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} strokeWidth={3} />}
            {loading ? "Shopping lines…" : "Re-shop lines"}
          </button>
          {data && <span className="text-xs text-white/40 uppercase tracking-widest font-bold">Updated {ago(data.generatedAt)}</span>}
        </div>
      </motion.div>

      {error && (
        <div className="rounded-2xl border-4 border-[#F87171] bg-[#F87171]/10 p-4 text-white mb-6">Couldn&apos;t build the slate: {error}</div>
      )}

      {data && slate && (
        <>
          {/* Stat strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <StatTile label="Props scanned" value={data.coverage.eligible.toLocaleString()} sub={`${data.coverage.boardProps.toLocaleString()} on board · standard only`} color="#FF3AF2" delay={0} />
            <StatTile label="Market-priced" value={data.coverage.marketPriced.toLocaleString()} sub={`${data.coverage.bookMatched} via books · ${data.coverage.kalshiMatched} via Kalshi`} color="#00F5D4" delay={0.05} />
            <StatTile label="Avg pick on slate" value={pct(avgLeg)} sub={`breakeven ${pct(slate.breakeven)} at ${slate.multiplier}×`} color={avgLeg >= slate.breakeven ? "#4ADE80" : "#FFE600"} delay={0.1} />
            <StatTile label="Unique picks" value={`${slate.uniquePicks}`} sub={repeats === 0 ? "0 repeats across all slips" : `${repeats} repeated!`} color={repeats === 0 ? "#FFE600" : "#F87171"} delay={0.15} />
          </div>

          {/* Source health */}
          <div className="flex flex-wrap gap-2 mb-6 text-xs">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1.5 font-bold",
              books?.configured && books.ok ? "border-[#4ADE80] text-[#4ADE80]" : "border-[#FF6B35] text-[#FF6B35]")}>
              <ShieldCheck size={13} />
              Sportsbooks: {books?.configured
                ? books.ok ? `${books.books.length} books · ${books.quotes} lines` : `error — ${books.error}`
                : "add ODDS_API_KEY to .env.local"}
              {books?.requestsRemaining != null && <span className="text-white/40">· {books.requestsRemaining} credits left</span>}
            </span>
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1.5 font-bold",
              data.sources.kalshi.ok ? "border-[#00F5D4] text-[#00F5D4]" : "border-[#FF6B35] text-[#FF6B35]")}>
              <Landmark size={13} /> Kalshi: {data.sources.kalshi.ok
                ? `${data.sources.kalshi.matched} matched · ${data.sources.kalshi.seriesTracked} ladders`
                : "unreachable right now"}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-[#7B2FFF] px-3 py-1.5 font-bold text-[#C4A6FF]">
              <Brain size={13} /> Model trained {ago(data.modelTrainedAt)}
            </span>
            {data.board.stale && (
              <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-[#FFE600] px-3 py-1.5 font-bold text-[#FFE600]">
                <TriangleAlert size={13} /> PrizePicks board is a cached snapshot
              </span>
            )}
          </div>

          {!data.board.error && weakLineups > 0 && (
            <div className="rounded-2xl border-4 border-[#FFE600] bg-[#FFE600]/10 p-4 text-sm text-white/85 mb-6 flex gap-2">
              <TriangleAlert size={18} className="text-[#FFE600] shrink-0 mt-0.5" />
              <div>
                {weakLineups} of {slate.lineups.length} lineups include picks with no book or Kalshi price
                (only {data.coverage.marketPriced} props are market-priced right now). Those legs are filler to keep the slate at {slate.requested} —
                {books?.configured ? " check back closer to game time when more props are posted." : " add an ODDS_API_KEY to price the whole board."}
              </div>
            </div>
          )}

          {(slate.shortfall || data.board.error) && (
            <div className="rounded-2xl border-4 border-[#FF6B35] bg-[#FF6B35]/10 p-4 text-sm text-white/85 mb-6 flex gap-2">
              <TriangleAlert size={18} className="text-[#FF6B35] shrink-0 mt-0.5" />
              <div>{data.board.error ? `PrizePicks board unavailable (${data.board.error}). Seed it from the Live Board, then re-shop.` : slate.shortfall}</div>
            </div>
          )}

          <div className="mb-8"><JuiceExplainer breakeven={slate.breakeven} mult={slate.multiplier} /></div>

          {/* The slate */}
          <div className="flex items-end justify-between gap-4 mb-5">
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-3xl md:text-4xl text-shadow-1">
              Today&apos;s {slate.lineups.length} Power Plays
            </h2>
            <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-white/50 font-bold uppercase tracking-widest">
              <Fingerprint size={14} /> each player + stat used once
            </span>
          </div>

          <AnimatePresence mode="popLayout">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {slate.lineups.map((l, i) => <LineupCard key={`${l.rank}-${l.picks.map((p) => p.id).join()}`} l={l} breakeven={slate.breakeven} i={i} />)}
            </div>
          </AnimatePresence>

          {/* Bench */}
          {data.bench.length > 0 && (
            <div className="mt-14">
              <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-2xl mb-4 text-shadow-1">Next best market picks</h2>
              <div className="rounded-2xl border-4 border-white/10 overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="text-[10px] uppercase tracking-[0.2em] text-white/45 bg-white/5">
                    <tr>
                      <th className="text-left px-4 py-2.5">Player</th>
                      <th className="text-left px-3 py-2.5">Prop</th>
                      <th className="text-left px-3 py-2.5">Side</th>
                      <th className="text-right px-3 py-2.5">Fair</th>
                      <th className="text-left px-4 py-2.5">Sources</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bench.map((p) => (
                      <tr key={p.id} className="border-t border-white/5">
                        <td className="px-4 py-2 font-bold text-white whitespace-nowrap">{p.prop.playerName}<span className="text-white/35 font-normal"> · {p.prop.sport}</span></td>
                        <td className="px-3 py-2 text-white/70 whitespace-nowrap">{p.prop.line} {p.prop.statType}</td>
                        <td className="px-3 py-2"><SidePill side={p.side} /></td>
                        <td className="px-3 py-2 text-right font-[family-name:var(--font-display)] text-base" style={{ color: p.p >= slate.breakeven ? "#4ADE80" : "#FFE600" }}>{pct(p.p)}</td>
                        <td className="px-4 py-2"><div className="flex flex-wrap gap-1">{p.sources.map((s, i) => <SourceChip key={i} s={s} side={p.side} />)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[11px] text-white/35 mt-10 leading-relaxed max-w-3xl">
            Probabilities are vig-free market consensus (books weighted equally, Kalshi weighted by spread tightness); hit chance assumes legs are independent.
            Markets are sharp but not perfect — this finds where PrizePicks&apos; flat pricing disagrees with them, it doesn&apos;t guarantee a profit. Bet what you can afford to lose.
          </p>
        </>
      )}

      {loading && !data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-80 rounded-3xl border-4 border-white/10 bg-white/[0.03] animate-pulse" />
          ))}
        </div>
      )}
    </div>
  );
}
