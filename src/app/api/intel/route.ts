import { NextResponse } from "next/server";
import { fetchMatchupNews, type NewsItem } from "@/lib/espnNews";
import {
  extractHeuristicSignals,
  combinedSwing,
  type IntelSignal,
} from "@/lib/heuristicIntel";
import { claudeMatchupSignals } from "@/lib/claudeIntel";
import type { Prop } from "@/lib/types";

export const dynamic = "force-dynamic";

interface IntelRequest {
  prop: Prop;
  anthropicKey?: string;
}

export interface IntelResponse {
  available: boolean;
  signals: IntelSignal[];
  combinedSwing: number;
  newsCount: number;
  source: "heuristic" | "heuristic+claude";
  topHeadlines: Array<{ headline: string; description: string }>;
  reason?: string;
}

/**
 * Find ESPN athlete ID by name. Mirrors the search step in realProjections.
 */
async function findEspnAthleteId(playerName: string, league: "nba" | "wnba" | "mlb"): Promise<number | null> {
  const cleaned = playerName.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const sport = league === "mlb" ? "baseball" : "basketball";
  const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(cleaned)}&limit=10&page=1&type=player`;
  try {
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: Array<{ id?: string; sport?: string; league?: string; type?: string }> };
    const exact = (data.items ?? []).find(
      (it) => it.type === "player" && it.sport === sport && it.league === league,
    );
    return exact?.id ? Number(exact.id) : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as IntelRequest;
    const prop = body.prop;
    if (!prop) {
      return NextResponse.json(
        { available: false, reason: "Missing prop" } satisfies Partial<IntelResponse>,
        { status: 400 },
      );
    }

    const sport = prop.sport.toUpperCase();
    const league: "nba" | "wnba" | "mlb" | null =
      sport === "NBA" ? "nba" : sport === "WNBA" ? "wnba" : sport === "MLB" ? "mlb" : null;
    if (!league) {
      return NextResponse.json({
        available: false,
        signals: [],
        combinedSwing: 0,
        newsCount: 0,
        source: "heuristic",
        topHeadlines: [],
        reason: `No intel source for ${prop.sport}`,
      } satisfies IntelResponse);
    }

    const athleteId = await findEspnAthleteId(prop.playerName, league);
    if (!athleteId) {
      return NextResponse.json({
        available: false,
        signals: [],
        combinedSwing: 0,
        newsCount: 0,
        source: "heuristic",
        topHeadlines: [],
        reason: `Could not resolve "${prop.playerName}" on ESPN`,
      } satisfies IntelResponse);
    }

    const news: NewsItem[] = await fetchMatchupNews({
      athleteId,
      playerName: prop.playerName,
      league,
      opponent: prop.opponent,
      playerTeam: prop.team,
    });

    const heuristic = extractHeuristicSignals(news, prop.playerName);

    // Optional Claude enrichment
    let claudeSignals: IntelSignal[] = [];
    const apiKey = body.anthropicKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey && news.length > 0) {
      claudeSignals = await claudeMatchupSignals({
        playerName: prop.playerName,
        statType: prop.statType,
        line: prop.line,
        opponent: prop.opponent,
        news,
        apiKey,
      });
    }

    // Combine: heuristic + Claude. Dedupe by label (case-insensitive), preferring Claude.
    const merged = new Map<string, IntelSignal>();
    for (const s of heuristic) merged.set(s.label.toLowerCase(), s);
    for (const s of claudeSignals) merged.set(s.label.toLowerCase(), s);
    const signals = Array.from(merged.values());

    return NextResponse.json({
      available: true,
      signals,
      combinedSwing: combinedSwing(signals),
      newsCount: news.length,
      source: claudeSignals.length > 0 ? "heuristic+claude" : "heuristic",
      topHeadlines: news.slice(0, 5).map((n) => ({ headline: n.headline, description: n.description })),
    } satisfies IntelResponse);
  } catch (err) {
    return NextResponse.json(
      {
        available: false,
        signals: [],
        combinedSwing: 0,
        newsCount: 0,
        source: "heuristic",
        topHeadlines: [],
        reason: err instanceof Error ? err.message : String(err),
      } satisfies IntelResponse,
      { status: 500 },
    );
  }
}
