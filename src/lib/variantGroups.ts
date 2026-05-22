/**
 * PrizePicks groups projections for the same (player, statType, sport) into a
 * "family" with at most three variants shown in their app:
 *   - goblin   (green icon) — lower line, easier to hit, 0.85× payout
 *   - standard (no badge)   — true line, 1.0× payout
 *   - demon    (red/flame)  — higher line, harder to hit, 1.25× payout
 *
 * NOTE on the PrizePicks API: although their JSON sometimes ships multiple
 * goblin or demon entries per family (alternate-line promos / flash-sale
 * variants), the consumer app only DISPLAYS one of each. We mimic that here
 * — `groupByFamily` collapses duplicates by picking the rung CLOSEST to the
 * standard line (the "default" goblin / demon that PrizePicks's app shows).
 */

import type { OddsType, Prop } from "@/lib/types";

export interface VariantSet {
  standard?: Prop;
  demon?: Prop;
  goblin?: Prop;
}

/** Family key — same player + same statType + same game segment groups into one family.
 *
 * The segment (`sport`) matters because PrizePicks uses the same `statType` (e.g.
 * "Points") for full-game (sport="NBA"), first-quarter (sport="NBA1Q"), first-half
 * (sport="NBA1H"), etc. Without it, Mitchell's NBA1Q goblin 3.5 Points would end
 * up in the same family as his full-game goblin 22.5 Points — a meaningless mix.
 */
export function familyKey(playerName: string, statType: string, sport: string): string {
  const p = playerName.trim().toLowerCase().replace(/\s+/g, " ");
  const s = statType.trim().toLowerCase();
  const sp = sport.trim().toUpperCase();
  return `${p}::${s}::${sp}`;
}

export function familyKeyOf(prop: Prop): string {
  return familyKey(prop.playerName, prop.statType, prop.sport);
}

/**
 * Build a map from family key → VariantSet.
 *
 * Per (player, statType, sport):
 *   - `standard` is the single PrizePicks "true" line. If duplicates appear (very
 *     rare) we keep the lower one — PrizePicks's median tendency.
 *   - `goblin` is the goblin rung CLOSEST to standard. The PrizePicks app's
 *     displayed goblin is the "default" (least-conservative) one. Alternate lower
 *     goblins are flash-sale / promo variants the consumer app doesn't show.
 *   - `demon` is the demon rung CLOSEST to standard, same rationale.
 *
 * This matches what the user sees in the actual PrizePicks app, where every
 * player has at most ONE goblin and ONE demon swap option.
 */
export function groupByFamily(props: Prop[]): Map<string, VariantSet> {
  // Accumulate every candidate first, then collapse to the closest-to-standard rung
  type Accum = { standards: Prop[]; goblins: Prop[]; demons: Prop[] };
  const acc = new Map<string, Accum>();
  for (const p of props) {
    const k = familyKeyOf(p);
    const a = acc.get(k) ?? { standards: [], goblins: [], demons: [] };
    if (p.oddsType === "standard") a.standards.push(p);
    else if (p.oddsType === "goblin") a.goblins.push(p);
    else if (p.oddsType === "demon") a.demons.push(p);
    acc.set(k, a);
  }
  const map = new Map<string, VariantSet>();
  for (const [k, a] of acc) {
    const vs: VariantSet = {};
    // Pick the standard — prefer lower line if PrizePicks ships duplicates
    if (a.standards.length > 0) {
      vs.standard = a.standards.reduce((best, cur) => (cur.line < best.line ? cur : best));
    }
    // Pick the goblin closest to standard (highest goblin line). If no standard,
    // use the highest goblin overall as the "default" representative.
    if (a.goblins.length > 0) {
      const stdLine = vs.standard?.line ?? Infinity;
      // Sort: closest to (but below) standard first
      const sorted = [...a.goblins].sort((x, y) => {
        const dx = stdLine === Infinity ? -x.line : Math.abs(x.line - stdLine);
        const dy = stdLine === Infinity ? -y.line : Math.abs(y.line - stdLine);
        return dx - dy;
      });
      vs.goblin = sorted[0];
    }
    // Pick the demon closest to standard (lowest demon line above standard).
    if (a.demons.length > 0) {
      const stdLine = vs.standard?.line ?? -Infinity;
      const sorted = [...a.demons].sort((x, y) => {
        const dx = stdLine === -Infinity ? x.line : Math.abs(x.line - stdLine);
        const dy = stdLine === -Infinity ? y.line : Math.abs(y.line - stdLine);
        return dx - dy;
      });
      vs.demon = sorted[0];
    }
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

/** How many variants are populated (1..3). */
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
 * Pick the "primary" variant to render as the default card for a family —
 * we prefer standard, then goblin, then demon. The user can swap on the card.
 */
export function primaryVariant(vs: VariantSet): Prop | null {
  return vs.standard ?? vs.goblin ?? vs.demon ?? null;
}

/** Find a specific variant prop by its id, anywhere in this family. */
export function findVariantById(vs: VariantSet, propId: string): Prop | null {
  if (vs.standard?.id === propId) return vs.standard;
  if (vs.goblin?.id === propId) return vs.goblin;
  if (vs.demon?.id === propId) return vs.demon;
  return null;
}
