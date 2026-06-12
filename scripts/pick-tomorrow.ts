/**
 * One-off: build $10 of WNBA Power slips for tomorrow (2026-06-08).
 * User restrictions: consistent players only · .5 lines only (no whole numbers)
 * · easiest lines · mix in goblins. Real projections (mean, sigma, recent game
 * logs) come from the running dev server's /api/projection.
 *
 * Probabilities are computed PER LINE from the model's projection + sigma
 * (a normal CDF of the cushion past the line) — the API's pMore/pLess are tied
 * to one specific line and can't be reused across goblin/standard rungs. The
 * model z-prob is then blended with the real recent clear-rate so a leg has to
 * be easy by BOTH the projection and actual recent games.
 *
 * Output: two independent 2-pick Power plays ($5 each, flat 3x), no shared
 * players, each leg a .5 line.
 */
import { readFileSync } from "node:fs";
import type { Prop } from "../src/lib/types";
import { POWER_MULTIPLIERS, oddsPayoutFactor } from "../src/lib/optimizer";

const SERVER = "http://localhost:3007";
const TOMORROW = "2026-06-08";
const famKey = (p: Prop) => p.groupKey || `${p.playerName}|${p.statType}`;

// Normal CDF via Abramowitz-Stegun erf approximation.
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-(z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  p = 1 - p;
  return z >= 0 ? p : 1 - p;
}

type Leg = {
  prop: Prop;
  side: "more" | "less";
  z: number;
  modelP: number;
  clear: number;
  blend: number;
  proj: number;
};

async function main() {
  const all: Prop[] = JSON.parse(readFileSync("/tmp/eb_props.json", "utf8")).props;

  const pool = all.filter(
    (p) =>
      p.sport === "WNBA" &&
      String(p.gameTime || "").slice(0, 10) === TOMORROW &&
      p.status === "active" &&
      !p.isLive &&
      !p.isCombo &&
      !Number.isInteger(p.line), // .5 lines only
  );

  // (player,stat) families — projection/sigma/recent are shared across rungs.
  const families = new Map<string, Prop[]>();
  for (const p of pool) {
    if (!families.has(famKey(p))) families.set(famKey(p), []);
    families.get(famKey(p))!.push(p);
  }
  console.log(`Pool: ${pool.length} .5 WNBA props tomorrow · ${families.size} (player,stat) families. Fetching real projections…`);

  const famProj = new Map<string, any>();
  await Promise.all(
    [...families.entries()].map(async ([k, vs]) => {
      try {
        const res = await fetch(`${SERVER}/api/projection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prop: vs[0] }),
        });
        famProj.set(k, await res.json());
      } catch {
        /* skip */
      }
    }),
  );
  const avail = [...famProj.values()].filter((j) => j?.available).length;
  console.log(`Real projections available for ${avail}/${families.size} families.\n`);

  // Best PLAYABLE leg per player. goblin/demon are MORE-only; standard either way.
  // Demons excluded (harder = not "easiest"). Require model AND recent games agree.
  const bestPerPlayer = new Map<string, Leg>();
  for (const [k, vs] of families) {
    const j = famProj.get(k);
    if (!j?.available || !j.sigma || !Array.isArray(j.recent) || j.recent.length < 6) continue;
    const proj: number = j.projection;
    const sigma: number = j.sigma;
    for (const p of vs) {
      if (p.oddsType === "demon") continue;
      const side: "more" | "less" = p.oddsType !== "standard" ? "more" : proj >= p.line ? "more" : "less";
      const cushion = side === "more" ? proj - p.line : p.line - proj;
      if (cushion <= 0) continue; // model must back the playable side
      const z = cushion / sigma;
      const modelP = phi(z);
      const hits = j.recent.filter((v: number) => (side === "more" ? v > p.line : v < p.line)).length;
      const clear = hits / j.recent.length;
      const blend = 0.5 * modelP + 0.5 * clear; // easy by model AND by recent games
      // Easiest/safest floors: both signals must be strong.
      if (modelP < 0.62 || clear < 0.7) continue;
      const cur = bestPerPlayer.get(p.playerName);
      const goblinBonus = p.oddsType === "goblin" ? 0.02 : 0;
      if (!cur || blend + goblinBonus > cur.blend + (cur.prop.oddsType === "goblin" ? 0.02 : 0)) {
        bestPerPlayer.set(p.playerName, { prop: p, side, z, modelP, clear, blend, proj });
      }
    }
  }

  const legs = [...bestPerPlayer.values()].sort((a, b) => b.blend - a.blend);
  console.log(`${legs.length} unique players with an EASY playable .5 leg (model ≥62% AND cleared ≥70%):`);
  for (const l of legs) {
    const tag = l.prop.oddsType === "goblin" ? "🟢GOB" : "  STD";
    console.log(
      `   ${tag} ${l.prop.playerName.padEnd(20)} ${l.side.toUpperCase()} ${l.prop.line} ${l.prop.statType.padEnd(11)} proj ${l.proj.toFixed(1)} z ${l.z.toFixed(2)} model ${(l.modelP * 100).toFixed(0)}% cleared ${(l.clear * 100).toFixed(0)}% → easy ${(l.blend * 100).toFixed(0)}%`,
    );
  }
  console.log("");

  // Build two independent 2-pick Power plays: greedily take the easiest legs,
  // no shared player AND no two legs from the same game on one slip.
  const gameOf = (p: Prop) => [p.team, p.opponent].sort().join("@");
  const slips: Leg[][] = [];
  const usedPlayers = new Set<string>();
  let plLegs = [...legs];
  while (slips.length < 2 && plLegs.length >= 2) {
    const slip: Leg[] = [];
    const games = new Set<string>();
    for (const l of plLegs) {
      if (slip.length === 2) break;
      if (usedPlayers.has(l.prop.playerName)) continue;
      if (games.has(gameOf(l.prop))) continue; // avoid intra-slip correlation
      slip.push(l);
      games.add(gameOf(l.prop));
    }
    if (slip.length < 2) break;
    slip.forEach((l) => usedPlayers.add(l.prop.playerName));
    slips.push(slip);
    plLegs = plLegs.filter((l) => !usedPlayers.has(l.prop.playerName));
  }

  const ENTRY = 5;
  console.log(`=== ${slips.length} independent 2-pick Power slips · $${ENTRY} each · $${ENTRY * slips.length} total ===`);
  console.log(`(payouts from the app's optimizer.ts: POWER base 3× × goblin-stack factor)\n`);
  slips.forEach((slip, i) => {
    const props = slip.map((l) => l.prop);
    const base = POWER_MULTIPLIERS[props.length]; // 2-pick = 3
    const factor = oddsPayoutFactor(props); // 0.85 per goblin, additive
    const mult = base * factor;
    const both = slip.reduce((a, l) => a * l.blend, 1);
    const nGob = props.filter((p) => p.oddsType === "goblin").length;
    console.log(
      `━━━ SLIP ${i + 1}  (Power · $${ENTRY} → $${(ENTRY * mult).toFixed(2)} on win · ${mult.toFixed(2)}x = 3× × ${factor.toFixed(2)} [${nGob} goblin]) ━━━`,
    );
    console.log(`   est. both-hit ≈ ${(both * 100).toFixed(0)}%  ·  breakeven ${(100 / mult).toFixed(0)}%`);
    for (const l of slip) {
      const p = l.prop;
      const tag = p.oddsType === "goblin" ? "🟢 GOBLIN" : "   STD   ";
      console.log(`   ${tag}  ${p.playerName}  ${l.side.toUpperCase()} ${p.line} ${p.statType}  (${p.team} v ${p.opponent})`);
      console.log(`             projects ${l.proj.toFixed(1)} · model ${(l.modelP * 100).toFixed(0)}% · cleared ${(l.clear * 100).toFixed(0)}% of recent`);
    }
    console.log("");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
