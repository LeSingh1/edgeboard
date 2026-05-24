import { NextResponse } from "next/server";
import { impliedProbability } from "@/lib/projectionModel";
import type { OddsType, Prop } from "@/lib/types";

export const revalidate = 300; // ISR: refresh every 5 min

const PRIZEPICKS_URL =
  "https://api.prizepicks.com/projections?per_page=1000&include=new_player,league,stat_type,game&single_stat=true";

// A handful of plausible real browser fingerprints. We rotate so consecutive
// retries from the same dev box don't all carry the same UA — PrizePicks
// rate-limits aggressively by (IP + UA) tuple from non-residential ranges.
// All are current desktop Chrome / Safari / Firefox versions.
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
];

/** Build a browser-shaped header set. Rotates UA per call. The Sec-Fetch-*
 *  trio matters — PrizePicks's edge filters bot traffic that lacks them. */
function browserHeaders(): Record<string, string> {
  const ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  return {
    "User-Agent": ua,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Origin: "https://app.prizepicks.com",
    Referer: "https://app.prizepicks.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

/**
 * Hit PrizePicks with exponential backoff. Cold-start path: when we have no
 * cached snapshot yet, a single 429 would leave the entire UI blank, so we
 * retry up to 3 times with 600ms / 1800ms / 4000ms gaps (honoring
 * `Retry-After` when PP includes it). Returns the first 2xx response or the
 * last failure if every attempt is rejected.
 */
async function fetchPP(): Promise<Response> {
  const delays = [0, 600, 1800, 4000];
  let last: Response | null = null;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const res = await fetch(PRIZEPICKS_URL, {
      headers: browserHeaders(),
      next: { revalidate: 300 },
    });
    if (res.ok) return res;
    last = res;
    // If PP told us how long to wait, respect it on the next iteration.
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const sec = Number(retryAfter);
      if (!isNaN(sec) && sec > 0 && sec <= 30) {
        await new Promise((r) => setTimeout(r, sec * 1000));
      }
    }
  }
  // Either way, give the caller the last non-ok response so it can decide.
  return last!;
}

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

/**
 * Parse a PrizePicks JSON:API body into the EdgeBoard `CachedPayload`
 * shape. Pure function — no side effects, no caching. Used by both the
 * live-fetch GET path and the manual-seed POST path (see /api/props
 * docstring) so the parsing logic stays in exactly one place.
 *
 * Filters applied here (mirrors PrizePicks UX, not editorial picks):
 *   - status === "pre_game" only (no in-play / settled rows)
 *   - half-point lines only (X.5) — whole-number rows are stale/junk
 */
function parseProjections(body: JsonApiResponse): CachedPayload {
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
    const descOpponent = (a.description as string) || "";
    const opp =
      matchup.home && matchup.away
        ? matchup.home === playerTeam
          ? matchup.away
          : matchup.away === playerTeam
            ? matchup.home
            : descOpponent
        : descOpponent;
    const isHome: boolean | undefined =
      matchup.home && matchup.away
        ? matchup.home === playerTeam
          ? true
          : matchup.away === playerTeam
            ? false
            : undefined
        : undefined;

    const line = Number(a.line_score ?? 0);
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
      groupKey: typeof a.group_key === "string" ? a.group_key : undefined,
      rank: typeof a.rank === "number" ? a.rank : undefined,
      trendingCount: typeof a.trending_count === "number" ? a.trending_count : undefined,
      flashSaleLine: typeof a.flash_sale_line_score === "number" ? a.flash_sale_line_score : null,
      refundable: Boolean(a.refundable),
      adjustedOdds: Boolean(a.adjusted_odds),
      ...probs,
    });
  }

  const leagueCounts = new Map<string, { count: number; icon?: string }>();
  for (const prop of props) {
    const cur = leagueCounts.get(prop.sport) ?? { count: 0, icon: prop.leagueIcon };
    cur.count++;
    leagueCounts.set(prop.sport, cur);
  }
  const leagues = Array.from(leagueCounts.entries())
    .map(([name, { count, icon }]) => ({ name, count, icon }))
    .sort((a, b) => b.count - a.count);

  return {
    props,
    leagues,
    total: props.length,
    fetchedAt: new Date().toISOString(),
  };
}

export async function GET() {
  try {
    const res = await fetchPP();

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
    const payload = parseProjections(body);
    // Stash for the stale-fallback path so a future PP 429/403 has something
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

/**
 * Manual cache seed — bypass PerimeterX bot protection by pasting a fresh
 * PrizePicks JSON:API response captured from a real browser session.
 *
 * Why this exists: PrizePicks has deployed PX bot protection in front of
 * api.prizepicks.com. Server-side fetches from non-residential IPs without
 * solved PX cookies get HTTP 403 + a captcha challenge. We can't bypass
 * that without running a headful browser or paying for a proxy service.
 *
 * The workflow for personal use:
 *   1. In your real browser, open
 *      https://api.prizepicks.com/projections?per_page=1000&include=new_player,league,stat_type,game&single_stat=true
 *      (you're already PX-cleared because you visit app.prizepicks.com)
 *   2. Copy the raw JSON response (right-click → Save / view source / pretty-print).
 *   3. POST it to this endpoint:
 *        curl -X POST http://localhost:3000/api/props \
 *          -H "Content-Type: application/json" \
 *          --data-binary @projections.json
 *   4. Every subsequent GET to /api/props serves the parsed snapshot until
 *      you reseed or the process restarts.
 *
 * No auth — this is a personal-use tool. If you ever deploy it publicly,
 * gate this behind a token check before shipping.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as JsonApiResponse;
    if (!body || !Array.isArray(body.data)) {
      return NextResponse.json(
        { error: "POST body must be a PrizePicks JSON:API response with a top-level `data` array." },
        { status: 400 },
      );
    }
    const payload = parseProjections(body);
    lastGood = payload;
    return NextResponse.json({
      ok: true,
      total: payload.total,
      leagues: payload.leagues.map((l) => l.name),
      fetchedAt: payload.fetchedAt,
      message: `Seeded ${payload.total} props from manual upload. GET /api/props will now serve this snapshot.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to parse upload: ${String(err)}` },
      { status: 400 },
    );
  }
}
