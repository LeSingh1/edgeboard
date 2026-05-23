/**
 * PrizePicks-faithful family grouping.
 *
 * SOURCE OF TRUTH:
 *   PrizePicks tags every projection with a `group_key` (e.g.
 *   `188011-106-NBA_game_5wzqFAIAdZaOlCk7XW0fmwwY-11-false`). All projections
 *   sharing that string are one ladder of rungs in PrizePicks's own app — the
 *   goblin / standard / demon variants a user can swap between when they tap
 *   a card. That `group_key` is PrizePicks's canonical family identifier, so
 *   we mirror it byte-for-byte: family = group_key. This is the only
 *   "permanently true" way to group; deriving from (player, statType, sport)
 *   can silently merge unrelated promo ladders.
 *
 * RUNG SELECTION:
 *   PrizePicks's app card view shows ONE goblin, ONE standard, ONE demon
 *   even when their ladder ships several of each (e.g. SGA's PRA ladder has
 *   3 goblins + 1 standard + 3 demons). The rung PrizePicks features is the
 *   one with the highest `trending_count` — that's their own users' lived
 *   "default" choice. We pick the same rung so what we render matches what
 *   the user sees inside PrizePicks's app.
 *
 *   Tie-breakers, in order:
 *     1. higher trending_count       (PP's "most-picked" signal)
 *     2. closer-to-standard line     (visual prominence on the ladder)
 *     3. lower rank                  (PP's intra-group display order)
 *
 *   For families with no `group_key` from the API (rare — usually one-off
 *   props), we fall back to (player::statType::sport) so the legacy path
 *   still groups sensibly.
 */

import type { OddsType, Prop } from "@/lib/types";

export interface VariantSet {
  standard?: Prop;
  demon?: Prop;
  goblin?: Prop;
  /** All rungs PrizePicks shipped for this family, sorted by line ascending —
   *  not rendered on the card by default (matches PP's card UX of "one of each"),
   *  but available so future ladder UIs can surface every rung. */
  allRungs?: Prop[];
}

/**
 * Family key — uses PrizePicks's own `group_key` when present. Falls back to
 * a (player, statType, sport) tuple for the rare props PP ships without one.
 *
 * The sport-level scoping is kept in the fallback because PrizePicks uses the
 * same `statType` (e.g. "Points") for full-game (sport="NBA"), first-quarter
 * (sport="NBA1Q"), first-half (sport="NBA1H"), etc. Without it those segments
 * would smash into one family.
 */
export function familyKey(playerName: string, statType: string, sport: string): string {
  const p = playerName.trim().toLowerCase().replace(/\s+/g, " ");
  const s = statType.trim().toLowerCase();
  const sp = sport.trim().toUpperCase();
  return `derived::${p}::${s}::${sp}`;
}

export function familyKeyOf(prop: Prop): string {
  // PP's group_key is the canonical identifier — every rung of one ladder
  // shares it. Use it verbatim so EdgeBoard's families match PrizePicks's.
  if (prop.groupKey && prop.groupKey.length > 0) return `pp::${prop.groupKey}`;
  return familyKey(prop.playerName, prop.statType, prop.sport);
}

/**
 * Compare two candidate rungs of the same odds type — return the one PrizePicks
 * would feature on its card. PP's "most-picked" rung wins by `trending_count`;
 * ties fall through to closer-to-standard line, then lower `rank` (PP's intra-
 * group display order).
 */
function pickBetterRung(a: Prop, b: Prop, standardLine: number | undefined): Prop {
  const ta = a.trendingCount ?? 0;
  const tb = b.trendingCount ?? 0;
  if (ta !== tb) return ta > tb ? a : b;
  if (standardLine !== undefined) {
    const da = Math.abs(a.line - standardLine);
    const db = Math.abs(b.line - standardLine);
    if (da !== db) return da < db ? a : b;
  }
  const ra = a.rank ?? Number.POSITIVE_INFINITY;
  const rb = b.rank ?? Number.POSITIVE_INFINITY;
  return ra < rb ? a : b;
}

/**
 * Build a map from family key → VariantSet.
 *
 * For each family (group_key):
 *   - `standard` is the standard rung. If PP ships more than one (rare), we
 *     pick the highest-trending one — PP's own users' default.
 *   - `goblin`   is the highest-trending goblin (PP's app default goblin).
 *   - `demon`    is the highest-trending demon (PP's app default demon).
 *   - `allRungs` lists every rung PP shipped, sorted by line ascending.
 *
 * No invention, no guessing — every value rendered here is a value PrizePicks
 * itself sent us. Cards that look different from PrizePicks's app reflect a
 * stale fetch, not a transformation on our side.
 */
export function groupByFamily(props: Prop[]): Map<string, VariantSet> {
  // Accumulate every rung first
  type Accum = { standards: Prop[]; goblins: Prop[]; demons: Prop[]; all: Prop[] };
  const acc = new Map<string, Accum>();
  for (const p of props) {
    const k = familyKeyOf(p);
    const a = acc.get(k) ?? { standards: [], goblins: [], demons: [], all: [] };
    a.all.push(p);
    if (p.oddsType === "standard") a.standards.push(p);
    else if (p.oddsType === "goblin") a.goblins.push(p);
    else if (p.oddsType === "demon") a.demons.push(p);
    acc.set(k, a);
  }
  const map = new Map<string, VariantSet>();
  for (const [k, a] of acc) {
    const vs: VariantSet = {};
    // Standard first — its line anchors the goblin/demon tie-break.
    if (a.standards.length > 0) {
      vs.standard = a.standards.reduce((best, cur) => pickBetterRung(best, cur, undefined));
    }
    const stdLine = vs.standard?.line;
    if (a.goblins.length > 0) {
      vs.goblin = a.goblins.reduce((best, cur) => pickBetterRung(best, cur, stdLine));
    }
    if (a.demons.length > 0) {
      vs.demon = a.demons.reduce((best, cur) => pickBetterRung(best, cur, stdLine));
    }
    vs.allRungs = [...a.all].sort((x, y) => x.line - y.line);
    map.set(k, vs);
  }
  return map;
}

/** Return the VariantSet for a given prop (its family, including itself). */
export function getVariantSet(prop: Prop, allProps: Prop[]): VariantSet {
  const k = familyKeyOf(prop);
  const groups = groupByFamily(allProps);
  return groups.get(k) ?? { [prop.oddsType]: prop };
}

/** How many distinct odds types are present (1..3). */
export function variantCount(vs: VariantSet): number {
  let n = 0;
  if (vs.standard) n++;
  if (vs.demon) n++;
  if (vs.goblin) n++;
  return n;
}

/** Ordered list of available variants (low → high line): goblin, standard, demon. */
export function variantList(vs: VariantSet): Array<{ oddsType: OddsType; prop: Prop }> {
  const out: Array<{ oddsType: OddsType; prop: Prop }> = [];
  if (vs.goblin) out.push({ oddsType: "goblin", prop: vs.goblin });
  if (vs.standard) out.push({ oddsType: "standard", prop: vs.standard });
  if (vs.demon) out.push({ oddsType: "demon", prop: vs.demon });
  return out;
}

/**
 * Pick the "primary" variant to render as the default card for a family.
 *
 * PrizePicks's own card view defaults to the standard rung; goblin and demon
 * are surfaced via the swap arrow. We mirror that: standard → goblin → demon.
 */
export function primaryVariant(vs: VariantSet): Prop | null {
  return vs.standard ?? vs.goblin ?? vs.demon ?? null;
}

/** Find a specific variant prop by its id, anywhere in this family. */
export function findVariantById(vs: VariantSet, propId: string): Prop | null {
  if (vs.standard?.id === propId) return vs.standard;
  if (vs.goblin?.id === propId) return vs.goblin;
  if (vs.demon?.id === propId) return vs.demon;
  // Fall through to alt rungs PrizePicks shipped but we don't surface on the card.
  const alt = vs.allRungs?.find((p) => p.id === propId);
  return alt ?? null;
}
