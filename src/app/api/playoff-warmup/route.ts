import { NextResponse } from "next/server";
import { fetchPlayoffRoster } from "@/lib/playoffRoster";
import { fetchPlayerNews } from "@/lib/espnNews";
import { extractHeuristicSignals } from "@/lib/heuristicIntel";
import {
  playoffCache,
  playoffCacheSummary,
  playoffNameKey,
  type PlayoffCacheEntry,
} from "@/lib/playoffCache";

/**
 * Playoff cache warmup endpoint.
 *
 *   - GET  → returns the current state of the cache (which players we have
 *            data for, when it was warmed, what the active teams are).
 *   - POST → kicks off a fresh warmup as a streaming response so the UI
 *            can show progress per-player. Discovers alive playoff teams
 *            via ESPN scoreboard, pulls every team's roster, then for
 *            each player fetches their full ESPN news page and extracts
 *            heuristic intel signals. ~70 players × ~1s = a few minutes
 *            one-time.
 *
 * The cache is read by /api/intel so when a prop for a cached player
 * shows up, intel hits this in-memory cache instead of doing a cold
 * fetch — instant render, deeper signal set.
 *
 * Why not pre-fetch gamelogs (BallDontLie) too? The BallDontLie key
 * lives client-side in localStorage, server can't access it. The
 * projection store already caches per-prop after first hit, so the
 * worst case is a one-time lag when each player first appears.
 */

export async function GET() {
  return NextResponse.json(playoffCacheSummary());
}

export async function POST() {
  if (playoffCache.inProgress) {
    return NextResponse.json(
      { error: "Warmup already in progress", progress: playoffCache.progress },
      { status: 409 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (obj: Record<string, unknown>) => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      };

      playoffCache.inProgress = true;
      try {
        emit({ phase: "discover", message: "Finding alive playoff teams…" });
        const roster = await fetchPlayoffRoster();
        playoffCache.teams = roster.teams;
        playoffCache.progress = { done: 0, total: roster.players.length };
        emit({
          phase: "discovered",
          teams: roster.teams,
          totalPlayers: roster.players.length,
        });

        // Sequential per-player news fetch — ESPN rate-limits aggressive
        // concurrent scrapes, and this is a one-time warmup so the extra
        // ~1s per player is fine when progress is streamed back.
        for (let i = 0; i < roster.players.length; i++) {
          const p = roster.players[i];
          try {
            const news = await fetchPlayerNews(p.espnId, "nba");
            const signals = extractHeuristicSignals(news, p.name);
            const entry: PlayoffCacheEntry = {
              player: p,
              news,
              signals,
              warmedAt: new Date().toISOString(),
            };
            playoffCache.byEspnId.set(p.espnId, entry);
            playoffCache.byPlayerName.set(playoffNameKey(p.name), entry);
            playoffCache.progress.done = i + 1;
            emit({
              phase: "player",
              done: i + 1,
              total: roster.players.length,
              player: p.name,
              team: p.team,
              newsCount: news.length,
              signalCount: signals.length,
            });
          } catch (err) {
            emit({
              phase: "error",
              player: p.name,
              team: p.team,
              error: String(err),
            });
          }
        }

        playoffCache.warmedAt = new Date().toISOString();
        emit({
          phase: "done",
          warmedAt: playoffCache.warmedAt,
          teams: playoffCache.teams,
          playerCount: playoffCache.byEspnId.size,
        });
      } catch (err) {
        emit({ phase: "fatal", error: String(err) });
      } finally {
        playoffCache.inProgress = false;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}
