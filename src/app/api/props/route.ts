import { NextResponse } from "next/server";
import { impliedProbability } from "@/lib/projectionModel";
import type { OddsType, Prop } from "@/lib/types";

export const revalidate = 300; // ISR: refresh every 5 min

const PRIZEPICKS_URL =
  "https://api.prizepicks.com/projections?per_page=1000&include=new_player,league,stat_type,game&single_stat=true";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://app.prizepicks.com",
  Referer: "https://app.prizepicks.com/",
};

interface JsonApiResource {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data: { type: string; id: string } | null }>;
}

interface JsonApiResponse {
  data: JsonApiResource[];
  included: JsonApiResource[];
  meta?: Record<string, unknown>;
}

/**
 * Module-level snapshot of the last *successful* PP response we built.
 * Lives for the lifetime of the Node process (per route worker). When PP
 * rate-limits us (HTTP 429) or otherwise errors, we serve this stale-but-
 * usable payload instead of returning empty arrays + a red error page.
 *
 * Trade-off: lines/odds may be a few minutes stale during an outage, but
 * the entire UI keeps working. The `stale: true` flag + `staleSince` lets
 * the client surface a small "data is N seconds old" hint if it wants.
 *
 * Capped to whatever the route produces — we just hold the last
 * NextResponse-shaped object. Memory cost is negligible (a few hundred KB
 * worst case for a full board).
 */
type CachedPayload = {
  props: Prop[];
  leagues: { name: string; count: number; icon?: string }[];
  total: number;
  fetchedAt: string;
};
let lastGood: CachedPayload | null = null;

function attr<T = unknown>(r: JsonApiResource | undefined, key: string): T | undefined {
  return r?.attributes?.[key] as T | undefined;
}

function rel(r: JsonApiResource, key: string): string | undefined {
  return r.relationships?.[key]?.data?.id ?? undefined;
}

function pickGameMatchup(game?: JsonApiResource): { home?: string; away?: string } {
  if (!game) return {};
  const md = (game.attributes?.metadata ?? {}) as { game_info?: { teams?: { home?: { abbreviation?: string }; away?: { abbreviation?: string } } } };
  const teams = md.game_info?.teams ?? {};
  return {
    home: teams.home?.abbreviation,
    away: teams.away?.abbreviation,
  };
}

export async function GET() {
  try {
    const res = await fetch(PRIZEPICKS_URL, {
      headers: HEADERS,
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      // PrizePicks unhappy. Common cases: 429 (rate-limited — they limit
      // hard from cloud IPs), 5xx (their own incident), or 403 (UA block).
      // If we have a previous good snapshot, serve it stale so the user
      // doesn't see a black screen. The `stale: true` flag tells the UI
      // it's looking at cached data; HTTP status stays 200 because the
      // payload IS usable, just slightly old.
      if (lastGood) {
        const ageSec = Math.max(0, Math.round((Date.now() - new Date(lastGood.fetchedAt).getTime()) / 1000));
        return NextResponse.json(
          {
            ...lastGood,
            stale: true,
            upstreamStatus: res.status,
            staleAgeSec: ageSec,
          },
          {
            // Short browser cache so clients retry soon and we pick up
            // PP's recovery on the next refresh.
            headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
          },
        );
      }
      // No prior snapshot to fall back on — return the original 502 so
      // the UI can show its "Couldn't reach the board" state.
      return NextResponse.json(
        { error: `PrizePicks upstream ${res.status}`, props: [], leagues: [] },
        { status: 502 },
      );
    }

    const body = (await res.json()) as JsonApiResponse;

    const playerMap = new Map<string, JsonApiResource>();
    const leagueMap = new Map<string, JsonApiResource>();
    const statMap = new Map<string, JsonApiResource>();
    const gameMap = new Map<string, JsonApiResource>();
    for (const inc of body.included ?? []) {
      if (inc.type === "new_player") playerMap.set(inc.id, inc);
      else if (inc.type === "league") leagueMap.set(inc.id, inc);
      else if (inc.type === "stat_type") statMap.set(inc.id, inc);
      else if (inc.type === "game") gameMap.set(inc.id, inc);
    }

    const props: Prop[] = [];

    // Mirror every prop PrizePicks serves — no artificial cutoffs or filters
    // beyond their own status field. If PrizePicks shows it, EdgeBoard shows it.
    for (const p of body.data ?? []) {
      const a = p.attributes;
      const status = String(a.status ?? "");
      if (status !== "pre_game") continue;

      const playerId = rel(p, "new_player");
      const leagueId = rel(p, "league");
      const gameId = rel(p, "game");
      const player = playerId ? playerMap.get(playerId) : undefined;
      const league = leagueId ? leagueMap.get(leagueId) : undefined;
      const game = gameId ? gameMap.get(gameId) : undefined;

      const playerName = (attr<string>(player, "display_name") ?? "Unknown").trim();
      const playerImage = attr<string | null>(player, "image_url") ?? null;
      const playerTeam = attr<string>(player, "team") ?? "";
      const playerTeamName = attr<string>(player, "market") ?? attr<string>(player, "team_name") ?? "";
      const playerPosition = attr<string>(player, "position") ?? undefined;
      const leagueName = attr<string>(league, "name") ?? "OTHER";
      const leagueIcon = attr<string>(league, "image_url") ?? undefined;
      const isCombo = Boolean(attr(player, "combo")) || playerName.includes(" + ");

      const matchup = pickGameMatchup(game);
      // The "description" attribute is sometimes the opponent abbreviation
      const descOpponent = (a.description as string) || "";
      const opp =
        matchup.home && matchup.away
          ? matchup.home === playerTeam
            ? matchup.away
            : matchup.away === playerTeam
              ? matchup.home
              : descOpponent
          : descOpponent;
      // Home / away inference — only confident when we have a matchup pair AND
      // the player's team matches one side of it. Leaves undefined otherwise so
      // the projection engine knows not to fire the home/away signal.
      const isHome: boolean | undefined =
        matchup.home && matchup.away
          ? matchup.home === playerTeam
            ? true
            : matchup.away === playerTeam
              ? false
              : undefined
          : undefined;

      const line = Number(a.line_score ?? 0);

      // PrizePicks-only filter: real PP lines are always half-points (X.5) so
      // a pick can never push. Anything that arrives as a whole number (or
      // missing/zero) is either junk, a stale row, or a sport-specific edge
      // case we don't ship — drop it before it pollutes the board. Use a
      // small epsilon to be safe against FP noise.
      const frac = Math.abs(line - Math.floor(line));
      const isHalfPoint = Math.abs(frac - 0.5) < 0.001;
      if (!isHalfPoint) continue;

      const statType = (a.stat_display_name as string) ?? (a.stat_type as string) ?? "";
      const id = `pp-${p.id}`;
      const oddsTypeRaw = String(a.odds_type ?? "standard").toLowerCase();
      const oddsType: OddsType =
        oddsTypeRaw === "demon" || oddsTypeRaw === "goblin"
          ? (oddsTypeRaw as OddsType)
          : "standard";
      const probs = impliedProbability(oddsType);

      props.push({
        id,
        source: "prizepicks",
        externalId: p.id,
        sport: leagueName,
        league: leagueName,
        leagueIcon,
        playerName,
        playerImage,
        playerPosition,
        playerTeamName,
        isCombo,
        team: playerTeam,
        opponent: opp || "",
        isHome,
        gameTime: String(a.start_time ?? ""),
        statType,
        line,
        status: "active",
        oddsType,
        isPromo: Boolean(a.is_promo),
        isLive: Boolean(a.is_live),
        // PrizePicks's own canonical ladder identifier — see Prop type.
        // Pass through verbatim so our family grouping mirrors PP's own.
        groupKey: typeof a.group_key === "string" ? a.group_key : undefined,
        rank: typeof a.rank === "number" ? a.rank : undefined,
        trendingCount: typeof a.trending_count === "number" ? a.trending_count : undefined,
        flashSaleLine: typeof a.flash_sale_line_score === "number" ? a.flash_sale_line_score : null,
        refundable: Boolean(a.refundable),
        adjustedOdds: Boolean(a.adjusted_odds),
        ...probs,
      });
    }

    // League counts for the tabs
    const leagueCounts = new Map<string, { count: number; icon?: string }>();
    for (const prop of props) {
      const cur = leagueCounts.get(prop.sport) ?? { count: 0, icon: prop.leagueIcon };
      cur.count++;
      leagueCounts.set(prop.sport, cur);
    }
    const leagues = Array.from(leagueCounts.entries())
      .map(([name, { count, icon }]) => ({ name, count, icon }))
      .sort((a, b) => b.count - a.count);

    const payload: CachedPayload = {
      props,
      leagues,
      total: props.length,
      fetchedAt: new Date().toISOString(),
    };
    // Stash for the stale-fallback path so a future PP 429 has something
    // to serve instead of an empty board.
    lastGood = payload;
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, TLS). Same logic: if we have a
    // previous good snapshot, serve it stale instead of going dark.
    if (lastGood) {
      const ageSec = Math.max(0, Math.round((Date.now() - new Date(lastGood.fetchedAt).getTime()) / 1000));
      return NextResponse.json(
        { ...lastGood, stale: true, upstreamError: String(err), staleAgeSec: ageSec },
        { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
      );
    }
    return NextResponse.json(
      { error: String(err), props: [], leagues: [] },
      { status: 500 },
    );
  }
}
