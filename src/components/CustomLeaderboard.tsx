"use client";

/**
 * Custom Leaderboard
 *
 * Lets the user paste an arbitrary array of picks (player + team + opp +
 * stat + line + side, optional oddsType), scores each through the model
 * via `/api/projection`, and renders a ranked leaderboard sorted by the
 * model's edge on the chosen side.
 *
 * Input format (one pick per line, pipe-delimited):
 *
 *   Player Name | Team | Opp | Stat | Line | Side | OddsType (optional)
 *
 * Example:
 *   Jalen Brunson | NY | CLE | Points | 28.5 | MORE
 *   Victor Wembanyama | SA | OKC | Rebounds | 10.5 | MORE | goblin
 *   James Harden | CLE | NYK | Points | 18.5 | LESS
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { Plus, Loader2, ArrowDown, ArrowUp, ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Prop, OddsType, PickSide } from "@/lib/types";
import { useSettingsStore } from "@/stores/settingsStore";

interface ParsedPick {
  raw: string;
  playerName: string;
  team: string;
  opponent: string;
  statType: string;
  line: number;
  side: PickSide;
  oddsType: OddsType;
}

interface ParseError {
  line: number;
  raw: string;
  reason: string;
}

interface ScoredRow {
  pick: ParsedPick;
  /** Probability the chosen side hits, per the model. */
  modelProb: number;
  /** Edge = modelProb − implied. Implied is 0.5 for standard, ~0.65 for
   *  goblin, ~0.35 for demon. */
  edge: number;
  projection: number | null;
  baselinePMore: number | null;
  modelVersion: string;
  recentAvg: number | null;
  source: "real" | "no-model";
  error?: string;
}

const PLACEHOLDER = `Jalen Brunson | NY | CLE | Points | 28.5 | MORE
Victor Wembanyama | SA | OKC | Rebounds | 10.5 | MORE | goblin
James Harden | CLE | NYK | Points | 18.5 | LESS
Shai Gilgeous-Alexander | OKC | SA | Pts+Asts | 36.5 | MORE`;

/** Implied pMore by oddsType (PrizePicks convention). */
function impliedPMore(oddsType: OddsType): number {
  if (oddsType === "goblin") return 0.65;
  if (oddsType === "demon") return 0.35;
  return 0.5;
}

function parsePicks(text: string): { picks: ParsedPick[]; errors: ParseError[] } {
  const picks: ParsedPick[] = [];
  const errors: ParseError[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const fields = raw.split("|").map((f) => f.trim()).filter((f) => f.length > 0);
    if (fields.length < 6) {
      errors.push({
        line: i + 1,
        raw,
        reason: `Expected at least 6 fields (player | team | opp | stat | line | side), got ${fields.length}`,
      });
      continue;
    }
    const [playerName, team, opponent, statType, lineStr, sideStr, oddsStr] = fields;
    const line = parseFloat(lineStr);
    if (!Number.isFinite(line)) {
      errors.push({ line: i + 1, raw, reason: `Line "${lineStr}" is not a number` });
      continue;
    }
    const sideUpper = sideStr.toUpperCase();
    const side: PickSide | null =
      sideUpper === "MORE" || sideUpper === "OVER" || sideUpper === "O"
        ? "more"
        : sideUpper === "LESS" || sideUpper === "UNDER" || sideUpper === "U"
          ? "less"
          : null;
    if (!side) {
      errors.push({ line: i + 1, raw, reason: `Side "${sideStr}" must be MORE/LESS (or OVER/UNDER)` });
      continue;
    }
    const oddsLower = (oddsStr ?? "standard").toLowerCase();
    const oddsType: OddsType =
      oddsLower === "goblin" || oddsLower === "demon" || oddsLower === "standard"
        ? (oddsLower as OddsType)
        : "standard";
    picks.push({ raw, playerName, team, opponent, statType, line, side, oddsType });
  }
  return { picks, errors };
}

async function scorePick(pick: ParsedPick, ballDontLieKey?: string): Promise<ScoredRow> {
  const prop: Prop = {
    id: `custom-${pick.playerName}-${pick.statType}-${pick.line}-${Date.now()}`,
    source: "manual",
    sport: "NBA",
    league: "NBA",
    playerName: pick.playerName,
    team: pick.team,
    opponent: pick.opponent,
    statType: pick.statType,
    line: pick.line,
    status: "active",
    oddsType: pick.oddsType,
    // Reasonable defaults — assume the next available game slot. The model
    // uses gameTime for playoff-window detection; today + 1h is safe for
    // current playoffs.
    gameTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    isHome: undefined,
    pMore: impliedPMore(pick.oddsType),
    pLess: 1 - impliedPMore(pick.oddsType),
    modelVersion: "implied-v1",
  };

  try {
    const res = await fetch("/api/projection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prop, ballDontLieKey }),
    });
    const body = (await res.json()) as
      | {
          available: true;
          pMore: number;
          pLess: number;
          projection: number;
          baselinePMore?: number;
          modelVersion: string;
          recent?: number[];
        }
      | { available: false; reason: string };
    if (!body.available) {
      return {
        pick,
        modelProb: pick.side === "more" ? prop.pMore : prop.pLess,
        edge: 0,
        projection: null,
        baselinePMore: null,
        modelVersion: "implied-v1",
        recentAvg: null,
        source: "no-model",
        error: body.reason,
      };
    }
    const modelProb = pick.side === "more" ? body.pMore : body.pLess;
    const implied = pick.side === "more" ? impliedPMore(pick.oddsType) : 1 - impliedPMore(pick.oddsType);
    const recent = body.recent ?? [];
    return {
      pick,
      modelProb,
      edge: modelProb - implied,
      projection: body.projection,
      baselinePMore: body.baselinePMore ?? null,
      modelVersion: body.modelVersion,
      recentAvg: recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
      source: "real",
    };
  } catch (e) {
    return {
      pick,
      modelProb: pick.side === "more" ? prop.pMore : prop.pLess,
      edge: 0,
      projection: null,
      baselinePMore: null,
      modelVersion: "implied-v1",
      recentAvg: null,
      source: "no-model",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type SortKey = "edge" | "modelProb" | "line";

export function CustomLeaderboard() {
  const ballDontLieKey = useSettingsStore((s) => s.ballDontLieKey);
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<ParseError[]>([]);
  const [rows, setRows] = useState<ScoredRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("edge");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  async function handleScore() {
    setLoading(true);
    setRows([]);
    const parsed = parsePicks(text);
    setErrors(parsed.errors);
    if (parsed.picks.length === 0) {
      setLoading(false);
      return;
    }
    // Concurrency limit of 3 to avoid bombing /api/projection
    const queue = [...parsed.picks];
    const inFlight: Promise<void>[] = [];
    const results: ScoredRow[] = [];
    while (queue.length > 0 || inFlight.length > 0) {
      while (inFlight.length < 3 && queue.length > 0) {
        const p = queue.shift()!;
        const fp = scorePick(p, ballDontLieKey).then((r) => {
          results.push(r);
          setRows([...results]);
        });
        inFlight.push(
          fp.finally(() => {
            const idx = inFlight.indexOf(fp);
            if (idx >= 0) inFlight.splice(idx, 1);
          }),
        );
      }
      if (inFlight.length > 0) await Promise.race(inFlight);
    }
    setLoading(false);
  }

  const sorted = [...rows].sort((a, b) => {
    const get = (r: ScoredRow): number =>
      sortKey === "edge" ? r.edge : sortKey === "modelProb" ? r.modelProb : r.pick.line;
    const d = get(a) - get(b);
    return sortDir === "desc" ? -d : d;
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <section className="rounded-3xl border-4 border-[#FFE600] bg-[#0D0D1A]/60 p-6 md:p-8">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap mb-5">
        <div className="w-12 h-12 rounded-2xl bg-[#FFE600] flex items-center justify-center flex-shrink-0">
          <ListChecks size={26} strokeWidth={3} className="text-[#0D0D1A]" aria-hidden />
        </div>
        <div className="flex-1 min-w-[260px]">
          <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-2xl md:text-3xl text-white leading-none">
            Custom Leaderboard
          </h2>
          <p className="text-white/65 text-sm mt-2 max-w-2xl">
            Paste your own array of picks below, one per line. Each line is{" "}
            <code className="text-[#FFE600] px-1.5 py-0.5 rounded bg-black/40 text-xs">
              Player | Team | Opp | Stat | Line | Side | OddsType
            </code>{" "}
            (OddsType optional — defaults to <em>standard</em>). The model scores each pick and
            ranks them by edge.
          </p>
        </div>
      </div>

      {/* Textarea + run */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 mb-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={8}
          spellCheck={false}
          className="w-full rounded-xl bg-black/40 border border-white/15 px-4 py-3 text-white/90 font-mono text-sm leading-relaxed placeholder-white/30 focus:border-[#FFE600] focus:outline-none resize-y"
        />
        <button
          type="button"
          onClick={handleScore}
          disabled={loading || text.trim().length === 0}
          className={cn(
            "h-fit self-start rounded-xl px-5 py-3 font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-sm",
            "bg-[#FFE600] text-[#0D0D1A] hover:bg-[#FFE600]/85 transition-colors",
            "disabled:opacity-40 disabled:cursor-not-allowed",
            "flex items-center gap-2",
          )}
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} strokeWidth={3} />}
          {loading ? `Scoring ${rows.length}…` : "Score & rank"}
        </button>
      </div>

      {/* Parse errors */}
      {errors.length > 0 && (
        <div className="mb-3 rounded-lg border border-[#F87171]/40 bg-[#F87171]/10 px-3 py-2 text-xs text-[#F87171]">
          <div className="font-bold uppercase tracking-wider mb-1">
            {errors.length} line{errors.length === 1 ? "" : "s"} skipped
          </div>
          {errors.slice(0, 5).map((e) => (
            <div key={e.line} className="font-mono">
              · L{e.line}: {e.reason}
            </div>
          ))}
        </div>
      )}

      {/* Leaderboard table */}
      {sorted.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-white/10 bg-[#0D0D1A] overflow-hidden mt-2"
        >
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-white/55 text-[10px] uppercase tracking-widest font-bold">
              <tr>
                <th className="px-3 py-2 text-left w-12">#</th>
                <th className="px-3 py-2 text-left">Player</th>
                <th className="px-3 py-2 text-left">Matchup</th>
                <th className="px-3 py-2 text-left">Pick</th>
                <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort("line")}>
                  <span className="inline-flex items-center gap-1">
                    Line {sortKey === "line" && (sortDir === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </span>
                </th>
                <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort("modelProb")}>
                  <span className="inline-flex items-center gap-1">
                    Model prob{" "}
                    {sortKey === "modelProb" && (sortDir === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </span>
                </th>
                <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort("edge")}>
                  <span className="inline-flex items-center gap-1">
                    Edge {sortKey === "edge" && (sortDir === "desc" ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </span>
                </th>
                <th className="px-3 py-2 text-right">Recent avg</th>
                <th className="px-3 py-2 text-right">Proj</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.pick.raw + i} className="border-t border-white/5">
                  <td className="px-3 py-2 text-white/40 font-mono">{i + 1}</td>
                  <td className="px-3 py-2 text-white/90 font-bold">{r.pick.playerName}</td>
                  <td className="px-3 py-2 text-white/55 text-xs uppercase tracking-wider">
                    {r.pick.team} vs {r.pick.opponent}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                        r.pick.side === "more"
                          ? "bg-[#4ADE80]/15 text-[#4ADE80]"
                          : "bg-[#F87171]/15 text-[#F87171]",
                      )}
                    >
                      {r.pick.side === "more" ? "More" : "Less"} · {r.pick.statType}
                    </span>
                    {r.pick.oddsType !== "standard" && (
                      <span
                        className={cn(
                          "ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider",
                          r.pick.oddsType === "goblin"
                            ? "bg-[#4ADE80]/10 text-[#4ADE80]"
                            : "bg-[#FF6B35]/10 text-[#FF6B35]",
                        )}
                      >
                        {r.pick.oddsType}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-white/85 font-mono">{r.pick.line}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    <span
                      className={cn(
                        "font-bold",
                        r.modelProb >= 0.6 ? "text-[#4ADE80]" : r.modelProb >= 0.5 ? "text-white/85" : "text-[#F87171]",
                      )}
                    >
                      {(r.modelProb * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    <span
                      className={cn(
                        "font-bold",
                        r.edge >= 0.05 ? "text-[#4ADE80]" : r.edge >= 0 ? "text-white/85" : "text-[#F87171]",
                      )}
                    >
                      {r.edge >= 0 ? "+" : ""}
                      {(r.edge * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-white/55 font-mono">
                    {r.recentAvg !== null ? r.recentAvg.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-white/55 font-mono">
                    {r.projection !== null ? r.projection.toFixed(1) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Summary strip */}
          <div className="border-t border-white/10 bg-white/[0.03] px-3 py-2 flex flex-wrap items-center gap-4 text-[11px]">
            <span className="text-white/55">
              <strong className="text-white/85">{sorted.length}</strong> picks scored
            </span>
            <span className="text-[#4ADE80]">
              <strong>{sorted.filter((r) => r.edge >= 0.05).length}</strong> with edge ≥ 5%
            </span>
            <span className="text-white/55">
              Mean edge:{" "}
              <strong className="text-white/85">
                {(
                  (sorted.reduce((s, r) => s + r.edge, 0) / Math.max(1, sorted.length)) *
                  100
                ).toFixed(1)}
                %
              </strong>
            </span>
            {sorted.some((r) => r.source === "no-model") && (
              <span className="text-[#F87171]">
                <strong>{sorted.filter((r) => r.source === "no-model").length}</strong> couldn&apos;t be modeled
                (fallback to implied)
              </span>
            )}
          </div>
        </motion.div>
      )}
    </section>
  );
}
