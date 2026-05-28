import type { PlayerRef, RawGame } from "@/lib/sports/types";

// Nippon Professional Baseball. No public JSON API exists, so this scrapes
// npb.jp's per-game box scores (the official site). Bounded by MAX_GAMES so
// it doesn't dominate a full training run. Player names (Japanese) are used
// as stable IDs — npb.jp box pages expose no numeric athlete id in this view.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE = "https://npb.jp";
const MONTHS = ["03", "04", "05", "06", "07", "08", "09", "10"];
const MAX_GAMES = 4000;

const gamelogCache = new Map<string, RawGame[]>();

function cellsOf(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").replace(/　/g, "").trim());
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Pull the per-game box score base paths (e.g. /scores/2024/0329/g-t-01/) for a month. */
async function boxPathsForMonth(season: number, month: string): Promise<string[]> {
  const html = await fetchText(`${BASE}/games/${season}/schedule_${month}_detail.html`);
  if (!html) return [];
  const paths = new Set<string>();
  for (const m of html.matchAll(/\/scores\/\d{4}\/\d{4}\/[a-z]-[a-z]-\d{2}\//g)) paths.add(m[0]);
  return [...paths];
}

/** Parse one box.html into per-batter RawGames. Batting rows have a
 *  parenthesized fielding position in column 2, which separates them from
 *  pitching-table rows. */
function parseBox(html: string, eventId: string, gameDate: string): { player: PlayerRef; game: RawGame }[] {
  const out: { player: PlayerRef; game: RawGame }[] = [];
  for (const rm of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = cellsOf(rm[1]);
    if (c.length < 8) continue;
    if (!/^\(.+\)$/.test(c[1])) continue;   // batting rows only (position in parens)
    const name = c[2];
    if (!name) continue;
    const AB = parseInt(c[3], 10), R = parseInt(c[4], 10), H = parseInt(c[5], 10);
    const RBI = parseInt(c[6], 10), SB = parseInt(c[7], 10);
    if (![AB, R, H, RBI, SB].every(Number.isFinite)) continue;
    out.push({
      player: { id: name, name },
      game: { eventId, gameDate, stats: { AB, R, H, RBI, SB }, isPlayoff: false },
    });
  }
  return out;
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  gamelogCache.clear();
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();
  let games = 0;

  outer:
  for (const season of Array.from({ length: 10 }, (_, i) => y - 9 + i)) {
    for (const month of MONTHS) {
      const paths = await boxPathsForMonth(season, month);
      for (const path of paths) {
        if (games >= MAX_GAMES) break outer;
        const html = await fetchText(`${BASE}${path}box.html`);
        if (!html) continue;
        // gameDate from the path: /scores/YYYY/MMDD/...
        const dm = path.match(/\/scores\/(\d{4})\/(\d{2})(\d{2})\//);
        const gameDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : "";
        const parsed = parseBox(html, path, gameDate);
        if (parsed.length === 0) continue;
        games++;
        for (const { player, game } of parsed) {
          if (!seen.has(player.id)) seen.set(player.id, player);
          const log = gamelogCache.get(player.id) ?? [];
          log.push(game);
          gamelogCache.set(player.id, log);
        }
      }
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, _seasons: number[]): Promise<RawGame[]> {
  return gamelogCache.get(playerId) ?? [];
}

export async function fetchTeamSchedule(_teamAbbr: string, _season: number): Promise<string[]> {
  return [];
}
