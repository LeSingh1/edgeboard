"use client";

import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Calendar, Search, Filter, Sparkles, Loader2, RefreshCw } from "lucide-react";
import { PropBox } from "@/components/PropBox";
import { useSelectionStore } from "@/stores/selectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { Prop, LeagueSummary } from "@/lib/types";
import type { LiveGameStat } from "@/lib/liveStats";
import { matchPropToLive } from "@/lib/liveStats";
import { groupByFamily, familyKeyOf, primaryVariant, type VariantSet } from "@/lib/variantGroups";
import { cn } from "@/lib/cn";

const SORT_OPTIONS = [
  { id: "time", label: "Game time" },
  { id: "line", label: "Line value (desc)" },
  { id: "demons", label: "Demons first" },
  { id: "goblins", label: "Goblins first" },
] as const;
type SortId = (typeof SORT_OPTIONS)[number]["id"];

const PAGE_SIZE = 60;

interface ApiResponse {
  props: Prop[];
  leagues: LeagueSummary[];
  total: number;
  fetchedAt: string;
}

interface LiveStatsResponse {
  live: LiveGameStat[];
  count: number;
  fetchedAt: string;
}

/** Local YYYY-MM-DD for a Date (timezone-aware so "today" matches the user's calendar) */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateLabel(key: string): string {
  const today = dateKey(new Date());
  const tomorrow = dateKey(new Date(Date.now() + 86400000));
  if (key === today) return "Today";
  if (key === tomorrow) return "Tomorrow";
  // "Wed 5/22"
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

/** Count of props the current sport tab would show across every day — for the "All days" pill. */
function filteredCountAllDays(data: ApiResponse | null, sport: string): number {
  if (!data) return 0;
  if (sport === "ALL") return data.props.length;
  let n = 0;
  for (const p of data.props) if (p.sport === sport) n++;
  return n;
}

export default function LiveBoardPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sport, setSport] = useState<string>("ALL");
  const [dateFilter, setDateFilter] = useState<string>("all"); // "all" or YYYY-MM-DD
  const [sort, setSort] = useState<SortId>("time");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [liveStats, setLiveStats] = useState<LiveGameStat[]>([]);

  const picks = useSelectionStore((s) => s.picks);
  const setBenchOpen = useSelectionStore((s) => s.setBenchOpen);
  const pollingMinutes = useSettingsStore((s) => s.pollingMinutes);

  async function load(opts?: { force?: boolean }) {
    if (opts?.force) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch(opts?.force ? "/api/props?ts=" + Date.now() : "/api/props");
      if (!res.ok) throw new Error(`Upstream ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function loadLiveStats() {
    try {
      const res = await fetch("/api/live-stats?ts=" + Date.now());
      if (!res.ok) return;
      const json = (await res.json()) as LiveStatsResponse;
      setLiveStats(json.live ?? []);
    } catch {
      // Silent — live stats are bonus, never block the board
    }
  }

  useEffect(() => {
    // Defer so initial state isn't mutated during the effect's sync phase
    queueMicrotask(() => load());
    // Refresh on the user's configured cadence (default 5 min, set in /settings)
    const t = setInterval(() => load({ force: true }), pollingMinutes * 60 * 1000);
    return () => clearInterval(t);
  }, [pollingMinutes]);

  // Live stats poll on their own cadence — boxscores tick every ~60s
  useEffect(() => {
    queueMicrotask(() => loadLiveStats());
    const t = setInterval(() => loadLiveStats(), 60_000);
    return () => clearInterval(t);
  }, []);

  // Default sport tab to first league with props once data lands
  useEffect(() => {
    if (data && sport === "ALL" && data.leagues.length > 0) {
      // Stick with ALL but if there are many leagues, pick the biggest
      // We keep ALL by default — let user pick
    }
  }, [data, sport]);

  // Available date buckets for the current sport tab — recomputed when sport changes
  // so the pill row mirrors what the user could possibly see.
  const availableDates = useMemo(() => {
    if (!data) return [] as { key: string; count: number }[];
    const counts = new Map<string, number>();
    for (const p of data.props) {
      if (sport !== "ALL" && p.sport !== sport) continue;
      if (!p.gameTime) continue;
      const d = new Date(p.gameTime);
      if (isNaN(d.getTime())) continue;
      const k = dateKey(d);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [data, sport]);

  // If the selected day disappears (e.g. user switched sport), fall back to "all".
  useEffect(() => {
    if (dateFilter === "all") return;
    if (!availableDates.some((d) => d.key === dateFilter)) {
      queueMicrotask(() => setDateFilter("all"));
    }
  }, [availableDates, dateFilter]);

  // Family map — groups demon/std/goblin variants for the same (player, statType).
  // Recomputed only when the props payload changes; cheap (a single linear scan).
  const familyMap = useMemo(() => {
    if (!data) return new Map<string, VariantSet>();
    return groupByFamily(data.props);
  }, [data]);

  // Family-deduplicated, filtered, sorted list — what actually renders to the grid.
  // The card knows about all variants in the family and shows a swap picker when >1.
  const filteredProps = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const collected: Prop[] = [];
    for (const p of data.props) {
      if (sport !== "ALL" && p.sport !== sport) continue;
      if (dateFilter !== "all" && p.gameTime) {
        const d = new Date(p.gameTime);
        if (!isNaN(d.getTime()) && dateKey(d) !== dateFilter) continue;
      }
      if (search) {
        const q = search.toLowerCase();
        if (
          !p.playerName.toLowerCase().includes(q) &&
          !p.statType.toLowerCase().includes(q) &&
          !p.team.toLowerCase().includes(q)
        ) {
          continue;
        }
      }
      // Dedupe by family — only render the primary variant; the card's VariantTabs handles swap
      const fk = familyKeyOf(p);
      if (seen.has(fk)) continue;
      seen.add(fk);
      const vs = familyMap.get(fk);
      collected.push(vs ? (primaryVariant(vs) ?? p) : p);
    }
    return [...collected].sort((a, b) => {
      if (sort === "line") return (b.line ?? 0) - (a.line ?? 0);
      if (sort === "demons") {
        // For each family, surface those with a demon variant available first
        const da = familyMap.get(familyKeyOf(a))?.demon ? 0 : 1;
        const db = familyMap.get(familyKeyOf(b))?.demon ? 0 : 1;
        if (da !== db) return da - db;
        return new Date(a.gameTime).getTime() - new Date(b.gameTime).getTime();
      }
      if (sort === "goblins") {
        const ga = familyMap.get(familyKeyOf(a))?.goblin ? 0 : 1;
        const gb = familyMap.get(familyKeyOf(b))?.goblin ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return new Date(a.gameTime).getTime() - new Date(b.gameTime).getTime();
      }
      return new Date(a.gameTime).getTime() - new Date(b.gameTime).getTime();
    });
  }, [data, sport, sort, search, dateFilter, familyMap]);

  // Reset visibility when filters change — deferred to avoid cascade-render warning
  useEffect(() => {
    queueMicrotask(() => setVisibleCount(PAGE_SIZE));
  }, [sport, sort, search, dateFilter]);

  const visibleProps = filteredProps.slice(0, visibleCount);
  const hasMore = visibleCount < filteredProps.length;

  const allLeagues: LeagueSummary[] = useMemo(() => {
    if (!data) return [];
    return [{ name: "ALL", count: data.total }, ...data.leagues];
  }, [data]);

  const fetchedAtLabel = data
    ? new Date(data.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "—";

  return (
    <div className="relative max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <div
        aria-hidden
        className="absolute -top-12 right-0 font-[family-name:var(--font-display)] text-[14rem] md:text-[20rem] leading-none pointer-events-none select-none opacity-[0.06] text-[#FF3AF2]"
      >
        BOARD
      </div>

      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="relative mb-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow">
              Tonight&apos;s Edge
            </h1>
            <p className="font-[family-name:var(--font-body)] text-white/70 text-lg mt-3 max-w-2xl">
              {loading
                ? "Pulling live PrizePicks board..."
                : error
                  ? `Couldn't reach PrizePicks: ${error}`
                  : `${filteredProps.length.toLocaleString()} props live · last refresh ${fetchedAtLabel}`}
            </p>
            <p className="text-white/40 text-xs mt-1 uppercase tracking-widest font-bold">
              Personal analytics · not affiliated with PrizePicks ·
              <span className="text-[#4ADE80]"> Edge</span> badge = % computed from player&apos;s game log ·
              No badge = PrizePicks data only, no model projection
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => load({ force: true })}
              disabled={refreshing || loading}
              className="flex items-center gap-2 px-4 py-3 rounded-2xl border-4 border-dashed border-[#00F5D4] bg-[#2D1B4E]/60 text-[#00F5D4] hover:bg-[#00F5D4]/10 transition-colors disabled:opacity-50"
            >
              <RefreshCw
                size={16}
                strokeWidth={3}
                className={refreshing ? "animate-spin" : ""}
              />
              <span className="font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-widest">
                Refresh
              </span>
            </button>
            <div className="flex items-center gap-2 px-5 py-3 rounded-2xl border-4 border-dashed border-[#FFE600] bg-[#2D1B4E]/60 backdrop-blur-sm">
              <Sparkles className="text-[#FFE600]" size={20} />
              <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-sm">
                <span className="text-[#FFE600]">{picks.length}</span>
                <span className="text-white/60"> on bench</span>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* League tabs */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1 }}
        className="relative mb-6"
      >
        <div className="flex gap-2 flex-wrap">
          {allLeagues.slice(0, 14).map((lg, i) => {
            const active = sport === lg.name;
            const ACCENTS = ["#FF3AF2", "#00F5D4", "#FFE600", "#FF6B35", "#7B2FFF"];
            const accent = ACCENTS[i % ACCENTS.length];
            const clash = ACCENTS[(i + 2) % ACCENTS.length];
            return (
              <button
                key={lg.name}
                onClick={() => setSport(lg.name)}
                className={cn(
                  "relative px-4 py-2 rounded-full border-4 font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-wider transition-all flex items-center gap-1.5",
                  active ? "text-[#0D0D1A]" : "text-white hover:scale-105",
                )}
                style={{
                  borderColor: accent,
                  background: active ? accent : "transparent",
                  boxShadow: active ? `3px 3px 0 ${clash}` : "none",
                }}
              >
                {lg.icon && lg.name !== "ALL" && (
                  // Render the real PrizePicks SVG as a raster image so the
                  // authentic multi-color logo (NBA blue+red, MLB red+blue,
                  // soccer ball, etc.) shows up — CSS mask would flatten
                  // every league to one accent color silhouette.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={lg.icon}
                    alt=""
                    aria-hidden
                    className="w-4 h-4 shrink-0 object-contain"
                    referrerPolicy="no-referrer"
                  />
                )}
                <span>{lg.name}</span>
                <span className={cn("text-[10px] opacity-70 font-bold")}>{lg.count}</span>
              </button>
            );
          })}
        </div>
      </motion.div>

      {/* Date pills — filter by when each game is */}
      {availableDates.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.12 }}
          className="relative mb-5 flex items-center gap-2 flex-wrap"
        >
          <span className="flex items-center gap-1.5 text-[10px] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white/50">
            <Calendar size={12} strokeWidth={3} className="text-[#FF6B35]" />
            Game day
          </span>
          {([{ key: "all", count: filteredCountAllDays(data, sport) }] as { key: string; count: number }[])
            .concat(availableDates)
            .map((d) => {
              const active = dateFilter === d.key;
              const label = d.key === "all" ? "All days" : dateLabel(d.key);
              return (
                <button
                  key={d.key}
                  onClick={() => setDateFilter(d.key)}
                  className={cn(
                    "px-3 py-1.5 rounded-full border-[3px] font-[family-name:var(--font-heading)] font-black uppercase text-[10px] tracking-widest transition-all flex items-center gap-1.5",
                    active
                      ? "bg-[#FF6B35] border-[#FFE600] text-[#0D0D1A] shadow-[2px_2px_0_#FFE600]"
                      : "border-[#FF6B35]/70 text-[#FF6B35] hover:bg-[#FF6B35]/10 hover:scale-105",
                  )}
                >
                  <span>{label}</span>
                  <span className={cn("text-[9px] font-bold", active ? "opacity-70" : "opacity-60")}>
                    {d.count}
                  </span>
                </button>
              );
            })}
        </motion.div>
      )}

      {/* Search + sort */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15 }}
        className="relative mb-8 flex gap-3 flex-wrap"
      >
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#FF3AF2]" size={18} strokeWidth={3} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player, stat, team..."
            className="w-full h-12 pl-12 pr-4 rounded-full border-4 border-[#FF3AF2] bg-[#2D1B4E]/60 backdrop-blur-sm font-bold text-white placeholder:text-white/40 focus:outline-none focus:border-[#FFE600] focus:ring-4 focus:ring-[#FF3AF2]/40 transition-all"
          />
        </div>
        <div className="flex items-center gap-2 px-4 py-1.5 rounded-full border-4 border-[#00F5D4] bg-[#2D1B4E]/60 backdrop-blur-sm">
          <Filter size={16} className="text-[#00F5D4]" strokeWidth={3} />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            className="bg-transparent text-white font-[family-name:var(--font-heading)] font-black uppercase text-xs tracking-wider focus:outline-none cursor-pointer"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id} className="bg-[#0D0D1A]">
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </motion.div>

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 size={48} className="text-[#FF3AF2] animate-spin" strokeWidth={3} />
          <p className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white/60">
            Loading {/* PrizePicks projections */} live board
          </p>
        </div>
      )}

      {/* Grid */}
      {!loading && (
        <div className="relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 md:gap-7">
          {visibleProps.map((p, i) => {
            const variants = familyMap.get(familyKeyOf(p));
            // Live-stat lookup closure — re-resolved when the card's user
            // swaps to a different variant (same player, different line)
            const liveStatFor = (activeProp: Prop) => {
              if (liveStats.length === 0) return null;
              const matched = matchPropToLive(liveStats, activeProp);
              if (!matched) return null;
              return {
                value: matched.value,
                periodLabel: matched.live.periodLabel,
                isFinal: matched.live.isFinal,
                homeScore: matched.live.homeScore,
                awayScore: matched.live.awayScore,
                homeAway: matched.live.homeAway,
              };
            };
            return (
              <PropBox
                key={p.id}
                prop={p}
                index={i}
                variants={variants}
                liveStatFor={liveStatFor}
              />
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && filteredProps.length === 0 && (
        <div className="text-center py-20">
          <h2 className="font-[family-name:var(--font-display)] text-6xl text-[#FF3AF2] text-shadow-2">
            No props match
          </h2>
          <p className="text-white/60 mt-3">
            Try a different sport, clear the search, or hit refresh.
          </p>
        </div>
      )}

      {/* Load more */}
      {!loading && hasMore && (
        <div className="flex justify-center mt-10">
          <button
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="px-8 py-4 rounded-full border-4 border-dashed border-[#FFE600] text-[#FFE600] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest hover:bg-[#FFE600]/10 transition-colors"
          >
            Load {Math.min(PAGE_SIZE, filteredProps.length - visibleCount)} more · {filteredProps.length - visibleCount} remaining
          </button>
        </div>
      )}

      {/* Sticky optimize CTA */}
      {picks.length > 0 && (
        <motion.div
          initial={{ y: 120, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 120, opacity: 0 }}
          className="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-2"
        >
          <button
            onClick={() => setBenchOpen(true)}
            className="text-xs text-white/60 hover:text-white px-3 py-1 rounded-full bg-[#0D0D1A] border-2 border-dashed border-[#FF3AF2]"
          >
            view bench
          </button>
          <Link
            href="/optimizer"
            className="relative px-8 py-5 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white text-base flex items-center gap-3 hover:scale-105 active:scale-95 transition-transform animate-(--animate-pulse-glow) shadow-[6px_6px_0_#FFE600,12px_12px_0_#FF3AF2]"
          >
            <Sparkles size={20} strokeWidth={3} />
            Optimize · {picks.length}
          </Link>
        </motion.div>
      )}
    </div>
  );
}
