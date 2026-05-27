/**
 * ESPN news fetcher — pulls recent article headlines + blurbs for a given
 * player and/or opposing team. Used by the matchup-intel engine to surface
 * qualitative signals: injuries, beef, motivation, narrative shifts.
 *
 * ESPN's per-athlete `/news` JSON endpoint returns empty for most athletes,
 * so we scrape the player's espn.com page HTML — it embeds inline JSON with
 * "headline" and "description" fields. Cheap, free, no auth.
 */

export interface NewsItem {
  headline: string;
  description: string;
  /** Whether the article appears to be recent (we approximate by ordering — first ones are newest) */
  recent: boolean;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/** Strip HTML entities + duplicates */
function cleanText(s: string): string {
  return s
    .replace(/\\"/g, '"')
    .replace(/\\u002F/g, "/")
    .replace(/\\\\/g, "\\")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .trim();
}

async function scrapeEspnPage(url: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      next: { revalidate: 1800 }, // 30-min cache
    });
    if (!res.ok) return [];
    const html = await res.text();
    const items: NewsItem[] = [];
    const seen = new Set<string>();

    // Strategy 1: find adjacent headline+description pairs (best case)
    const adjRe = /"headline":"([^"\\]{10,200}(?:\\.[^"\\]{0,200})*)"[\s,]+"description":"([^"\\]{10,500}(?:\\.[^"\\]{0,500})*)"/g;
    let m: RegExpExecArray | null;
    while ((m = adjRe.exec(html)) !== null) {
      const headline = cleanText(m[1]);
      const description = cleanText(m[2]);
      const key = headline.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ headline, description, recent: items.length < 4 });
      if (items.length >= 12) break;
    }

    // Strategy 2: any "headline":"..." not yet captured — ESPN often stores
    // the player page's article list with headlines but no adjacent description.
    // We treat headline-only items as their own news (no body text). The
    // heuristic parser can still match on the headline alone.
    if (items.length < 8) {
      const headRe = /"headline":"([^"\\]{10,200}(?:\\.[^"\\]{0,200})*)"/g;
      while ((m = headRe.exec(html)) !== null) {
        const headline = cleanText(m[1]);
        const key = headline.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        // Skip the page's own meta headline ("View the profile of...")
        if (/view the profile|get the latest news/i.test(headline)) continue;
        seen.add(key);
        items.push({
          headline,
          description: headline, // duplicate so heuristics still see the text
          recent: items.length < 4,
        });
        if (items.length >= 12) break;
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** ESPN athlete page — typically rich with player-specific news.
 *  As of 2026, the HTML page no longer embeds article JSON. Returns
 *  empty in most cases; callers should prefer `fetchPlayerNewsViaTeam`. */
export async function fetchPlayerNews(
  athleteId: number,
  league: "nba" | "wnba" | "mlb",
): Promise<NewsItem[]> {
  const url = `https://www.espn.com/${league}/player/_/id/${athleteId}`;
  return scrapeEspnPage(url);
}

// ────────────────────────────────────────────────────────────────────────
// Team-scoped news via the Core API — replacement for the deprecated
// per-athlete HTML scrape. Returns the team's recent news, filtered to
// articles that mention the target player by name.
// ────────────────────────────────────────────────────────────────────────

const NBA_TEAM_IDS: Record<string, number> = {
  ATL: 1,  BOS: 2,  BKN: 17, CHA: 30, CHI: 4,  CLE: 5,  DAL: 6,  DEN: 7,
  DET: 8,  GS: 9,   GSW: 9,  HOU: 10, IND: 11, LAC: 12, LAL: 13, MEM: 29,
  MIA: 14, MIL: 15, MIN: 16, NO: 3,   NOP: 3,  NY: 18,  NYK: 18, OKC: 25,
  ORL: 19, PHI: 20, PHX: 21, POR: 22, SAC: 23, SA: 24,  SAS: 24, TOR: 28,
  UTA: 26, UTAH: 26, WAS: 27, WSH: 27,
};

interface CoreNewsArticle {
  headline?: string;
  description?: string;
  published?: string;
}

/** Build name-match patterns: full name, last-name-only, "Last (First initial)". */
function namePatterns(playerName: string): RegExp[] {
  const parts = playerName.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const first = parts[0];
  return [
    new RegExp(`\\b${escapeRe(playerName)}\\b`, "i"),
    new RegExp(`\\b${escapeRe(last)}\\b`, "i"),
    // Headlines often shorten "Victor Wembanyama" → "Wemby" — last name catches most
    new RegExp(`\\b${escapeRe(first)}\\s+${escapeRe(last.charAt(0))}\\.`, "i"),
  ];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull a team's recent news and filter to articles that mention the player.
 * Each match becomes a NewsItem with the full headline + description so the
 * heuristic intel rules can fire on real text.
 */
export async function fetchPlayerNewsViaTeam(args: {
  playerName: string;
  teamAbbr: string;
  league?: "nba" | "wnba";
  limit?: number;
}): Promise<NewsItem[]> {
  const league = args.league ?? "nba";
  if (league !== "nba") return []; // team-id map is NBA-only for now
  const teamId = NBA_TEAM_IDS[args.teamAbbr.toUpperCase()];
  if (!teamId) return [];
  const sportPath = "basketball/nba";
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/news?team=${teamId}&limit=${args.limit ?? 30}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      next: { revalidate: 600 },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { articles?: CoreNewsArticle[] };
    const articles = body.articles ?? [];
    const patterns = namePatterns(args.playerName);
    const items: NewsItem[] = [];
    for (const a of articles) {
      const headline = (a.headline ?? "").trim();
      const description = (a.description ?? "").trim();
      const blob = `${headline} ${description}`;
      if (!patterns.some((p) => p.test(blob))) continue;
      items.push({
        headline,
        description: description || headline,
        recent: items.length < 6,
      });
      if (items.length >= 12) break;
    }
    return items;
  } catch {
    return [];
  }
}

/** ESPN league news endpoint — for opponent-team / general context. */
export async function fetchLeagueNews(
  league: "nba" | "wnba" | "mlb",
  limit = 25,
): Promise<NewsItem[]> {
  try {
    const sportPath =
      league === "mlb" ? "baseball/mlb" : league === "wnba" ? "basketball/wnba" : "basketball/nba";
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/news?limit=${limit}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      next: { revalidate: 1800 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { articles?: Array<{ headline?: string; description?: string }> };
    return (data.articles ?? [])
      .filter((a) => a.headline && a.description)
      .map((a, i) => ({
        headline: a.headline!,
        description: a.description!,
        recent: i < 5,
      }));
  } catch {
    return [];
  }
}

// Team abbreviation → keyword aliases. News text uses team names (Knicks,
// Lakers, Cavaliers) but our prop data uses 2-3 letter abbreviations (NY, LAL,
// CLE). This map lets the filter match either form.
const NBA_TEAM_ALIASES: Record<string, string[]> = {
  ATL: ["hawks", "atlanta"],
  BOS: ["celtics", "boston"],
  BKN: ["nets", "brooklyn"],
  CHA: ["hornets", "charlotte"],
  CHI: ["bulls", "chicago"],
  CLE: ["cavaliers", "cavs", "cleveland"],
  DAL: ["mavericks", "mavs", "dallas"],
  DEN: ["nuggets", "denver"],
  DET: ["pistons", "detroit"],
  GSW: ["warriors", "golden state"],
  GS: ["warriors", "golden state"],
  HOU: ["rockets", "houston"],
  IND: ["pacers", "indiana"],
  LAC: ["clippers", "los angeles"],
  LAL: ["lakers", "los angeles"],
  MEM: ["grizzlies", "memphis"],
  MIA: ["heat", "miami"],
  MIL: ["bucks", "milwaukee"],
  MIN: ["timberwolves", "minnesota", "wolves"],
  NOP: ["pelicans", "new orleans"],
  NO: ["pelicans", "new orleans"],
  NY: ["knicks", "new york"],
  NYK: ["knicks", "new york"],
  OKC: ["thunder", "oklahoma"],
  ORL: ["magic", "orlando"],
  PHI: ["76ers", "sixers", "philadelphia"],
  PHX: ["suns", "phoenix"],
  POR: ["trail blazers", "blazers", "portland"],
  SAC: ["kings", "sacramento"],
  SAS: ["spurs", "san antonio"],
  SA: ["spurs", "san antonio"],
  TOR: ["raptors", "toronto"],
  UTA: ["jazz", "utah"],
  UTAH: ["jazz", "utah"],
  WAS: ["wizards", "washington"],
};

/** Build the full set of search keywords for a team — both the raw abbr and team-name aliases. */
function teamKeywords(abbr?: string): string[] {
  if (!abbr) return [];
  const key = abbr.toUpperCase();
  const aliases = NBA_TEAM_ALIASES[key] ?? [];
  return [key.toLowerCase(), ...aliases];
}

/** Pull news for a (player, opponent) pair: player page first, then league news filtered to mentions. */
export async function fetchMatchupNews(args: {
  athleteId: number;
  playerName: string;
  league: "nba" | "wnba" | "mlb";
  opponent?: string;     // abbreviation
  playerTeam?: string;   // abbreviation for the player's own team
}): Promise<NewsItem[]> {
  const [playerNews, leagueNews] = await Promise.all([
    fetchPlayerNews(args.athleteId, args.league),
    fetchLeagueNews(args.league, 25),
  ]);

  // Match keywords: player last name, opponent team aliases, player's own team aliases
  const lastName = args.playerName.toLowerCase().split(/\s+/).slice(-1)[0];
  // Require last name >= 4 chars (avoid "li", "wu", etc. matching everywhere)
  const playerKeys = lastName && lastName.length >= 4 ? [lastName] : [];
  const oppKeys = teamKeywords(args.opponent);
  const teamKeys = teamKeywords(args.playerTeam);
  const matchKeys = [...playerKeys, ...oppKeys, ...teamKeys];

  const seen = new Set(playerNews.map((p) => p.headline.toLowerCase().slice(0, 60)));
  for (const it of leagueNews) {
    const blob = `${it.headline} ${it.description}`.toLowerCase();
    if (!matchKeys.some((k) => blob.includes(k))) continue;
    const key = it.headline.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    playerNews.push(it);
    if (playerNews.length >= 15) break;
  }
  return playerNews;
}
