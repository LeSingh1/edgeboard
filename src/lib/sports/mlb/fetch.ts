import type { PlayerRef, RawGame } from "@/lib/sports/types";

export async function fetchTeamSchedule(_team: string, season: number): Promise<string[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&fields=dates,games,gamePk`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const body = await res.json() as { dates?: Array<{ games?: Array<{ gamePk?: number }> }> };
    const ids: string[] = [];
    for (const d of body.dates ?? []) for (const g of d.games ?? []) if (g.gamePk) ids.push(String(g.gamePk));
    return ids;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  const url = `https://statsapi.mlb.com/api/v1/teams?sportId=1`;
  const teamsRes = await fetch(url);
  if (!teamsRes.ok) return [];
  const teams = (await teamsRes.json() as { teams?: Array<{ id?: number; abbreviation?: string }> }).teams ?? [];
  const out: PlayerRef[] = [];
  for (const t of teams) {
    if (!t.id) continue;
    const rosterRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${t.id}/roster?rosterType=active`);
    if (!rosterRes.ok) continue;
    const data = await rosterRes.json() as { roster?: Array<{ person?: { id?: number; fullName?: string } }> };
    for (const r of data.roster ?? []) {
      if (r.person?.id && r.person?.fullName) {
        out.push({ id: String(r.person.id), name: r.person.fullName, team: t.abbreviation });
      }
    }
  }
  return out;
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    for (const group of ["hitting", "pitching"] as const) {
      const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${season}&group=${group}`;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const body = await res.json() as { stats?: Array<{ splits?: Array<{ date?: string; opponent?: { abbreviation?: string }; isHome?: boolean; game?: { gamePk?: number }; stat?: Record<string, number | string> }> }> };
        for (const stat of body.stats ?? []) {
          for (const s of stat.splits ?? []) {
            out.push({
              eventId: String(s.game?.gamePk ?? `${playerId}-${s.date}-${group}`),
              gameDate: s.date ?? "",
              stats: { ...(s.stat ?? {}), type: group === "hitting" ? "hitter" : "pitcher" },
              opponentAbbr: s.opponent?.abbreviation,
              atVs: s.isHome ? "vs" : "@",
              isPlayoff: false,
            });
          }
        }
      } catch { /* skip */ }
    }
  }
  return out;
}
