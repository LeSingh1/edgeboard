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

    // Only filter on `status === "pre_game"` — that's PrizePicks' own "enterable now"
    // flag. Their `today` attribute is only true for same-day games and excludes
    // tomorrow's playoffs / next-morning matchups, which are very much enterable.
    // Cut off at 48h from now to avoid showing way-future props.
    const cutoff = Date.now() + 48 * 60 * 60 * 1000;
    for (const p of body.data ?? []) {
      const a = p.attributes;
      const status = String(a.status ?? "");
      if (status !== "pre_game") continue;
      const startTime = a.start_time ? new Date(String(a.start_time)).getTime() : 0;
      if (startTime > cutoff) continue;

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

      const line = Number(a.line_score ?? 0);
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
        gameTime: String(a.start_time ?? ""),
        statType,
        line,
        status: "active",
        oddsType,
        isPromo: Boolean(a.is_promo),
        isLive: Boolean(a.is_live),
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

    return NextResponse.json(
      {
        props,
        leagues,
        total: props.length,
        fetchedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: String(err), props: [], leagues: [] },
      { status: 500 },
    );
  }
}
