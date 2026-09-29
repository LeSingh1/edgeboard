/**
 * GET /api/line-betting — the Line Betting slate.
 *
 *   1. Pull the current PrizePicks board from our own /api/props (so a seeded
 *      snapshot and the stale-fallback cache are reused as-is).
 *   2. Price each standard prop against sportsbooks (The Odds API) and Kalshi.
 *   3. Take the side the market favors and build 10 unique 3-pick Power Plays.
 *
 * Query: ?mult=6|5 (Power Play 3-pick multiplier, default 6)
 *        &count=10  &legs=3
 */

import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prop } from "@/lib/types";
import { kalshiSignalForSeries, listKalshiSportsSeries, type KalshiSignal } from "@/lib/kalshi";
import { fetchSportsbookQuotes } from "@/lib/lineShop/sportsbooks";
import { buildKalshiSeriesIndex, isEligible, priceProps, rankPicks } from "@/lib/lineShop/engine";
import { buildSlate } from "@/lib/lineShop/lineups";
import { canonicalStat, LEAGUE_TO_ODDS_SPORT } from "@/lib/lineShop/stats";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function newestModelTrainedAt(): Promise<string | null> {
  const root = "data/training/artifacts";
  let newest: string | null = null;
  try {
    for (const d of await readdir(root)) {
      try {
        const meta = JSON.parse(await readFile(join(root, d, "metadata.json"), "utf8")) as { trainedAt?: string };
        if (meta.trainedAt && (!newest || meta.trainedAt > newest)) newest = meta.trainedAt;
      } catch { /* sport without metadata */ }
    }
  } catch { /* no artifacts dir */ }
  return newest;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mult = Number(url.searchParams.get("mult")) === 5 ? 5 : 6;
  const count = Math.min(20, Math.max(1, Number(url.searchParams.get("count")) || 10));
  const legs = Math.min(6, Math.max(2, Number(url.searchParams.get("legs")) || 3));

  // ── 1. PrizePicks board ──────────────────────────────────────────────────
  let props: Prop[] = [];
  let boardError: string | undefined;
  let boardStale = false;
  try {
    const res = await fetch(new URL("/api/props", url.origin), { cache: "no-store" });
    const body = (await res.json()) as { props?: Prop[]; error?: string; stale?: boolean };
    props = body.props ?? [];
    boardStale = Boolean(body.stale);
    if (!res.ok) boardError = body.error ?? `HTTP ${res.status}`;
  } catch (e) {
    boardError = e instanceof Error ? e.message : String(e);
  }
  const now = Date.now();
  const eligible = props.filter((p) => isEligible(p, now));

  // Which (league → stats) are worth asking the books about.
  const wanted = new Map<string, Set<string>>();
  for (const p of eligible) {
    const league = p.sport.toUpperCase();
    if (!LEAGUE_TO_ODDS_SPORT[league]) continue;
    const canon = canonicalStat(league, p.statType);
    if (!canon) continue;
    if (!wanted.has(league)) wanted.set(league, new Set());
    wanted.get(league)!.add(canon);
  }

  // ── 2a. Sportsbooks + 2b. Kalshi, in parallel ───────────────────────────
  const booksP = fetchSportsbookQuotes(wanted);
  const kalshiP = (async () => {
    const discovered = await listKalshiSportsSeries();
    const seriesIdx = buildKalshiSeriesIndex(discovered);
    // Group props by series so each series' market list is fetched once
    // (the first call warms kalshi.ts's cache, the rest hit it).
    const bySeries = new Map<string, Prop[]>();
    for (const p of eligible) {
      const league = p.sport.toUpperCase();
      const canon = canonicalStat(league, p.statType);
      const series = canon ? seriesIdx.get(`${league}|${canon}`) : undefined;
      if (!series) continue;
      if (!bySeries.has(series)) bySeries.set(series, []);
      bySeries.get(series)!.push(p);
    }
    const signals = new Map<string, KalshiSignal>();
    await Promise.all(
      [...bySeries].map(async ([series, ps]) => {
        for (const p of ps) {
          const sig = await kalshiSignalForSeries(series, p.playerName, p.line, p.gameTime).catch(() => null);
          if (sig) signals.set(p.id, sig);
        }
      }),
    );
    return { signals, seriesTracked: bySeries.size, reachable: discovered.length > 0 };
  })();

  const [{ quotes, status: booksStatus }, { signals, seriesTracked, reachable }] = await Promise.all([booksP, kalshiP]);

  // ── 3. Price + build ─────────────────────────────────────────────────────
  const ranked = rankPicks(priceProps(eligible, quotes, signals, now));
  const slate = buildSlate(ranked, { count, legs, multiplier: mult });

  const onSlate = new Set(slate.lineups.flatMap((l) => l.picks.map((p) => p.id)));
  const coverage = {
    boardProps: props.length,
    eligible: eligible.length,
    marketPriced: ranked.filter((p) => p.tier === "market").length,
    modelPriced: ranked.filter((p) => p.tier === "model").length,
    bookMatched: ranked.filter((p) => p.sources.some((s) => s.kind === "book")).length,
    kalshiMatched: signals.size,
    aboveBreakeven: ranked.filter((p) => p.tier !== "none" && p.p >= slate.breakeven).length,
  };

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    board: { error: boardError, stale: boardStale },
    sources: {
      sportsbooks: booksStatus,
      kalshi: { ok: reachable, seriesTracked, matched: signals.size },
    },
    modelTrainedAt: await newestModelTrainedAt(),
    coverage,
    slate,
    // Next-best market picks that didn't make the slate — the "bench".
    bench: ranked.filter((p) => !onSlate.has(p.id) && p.tier === "market").slice(0, 40),
  });
}
