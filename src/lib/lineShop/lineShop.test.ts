import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prop } from "@/lib/types";
import { americanToProb, devigTwoWay, breakevenPerLeg, shiftPOver, probToAmerican } from "./odds";
import { canonicalStat, normPlayer } from "./stats";
import { parseEventOdds, type BookQuote } from "./sportsbooks";
import { priceProps, rankPicks, buildKalshiSeriesIndex, isEligible } from "./engine";
import { buildSlate } from "./lineups";

const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();

function mkProp(over: Partial<Prop>): Prop {
  return {
    id: "pp-1", source: "prizepicks", sport: "NFL", league: "NFL",
    playerName: "Josh Allen", team: "BUF", opponent: "MIA", gameTime: FUTURE,
    statType: "Pass Yards", line: 245.5, status: "active", oddsType: "standard",
    pMore: 0.5, pLess: 0.5, modelVersion: "implied-v1",
    ...over,
  };
}

function quote(over: Partial<BookQuote>): BookQuote {
  return {
    league: "NFL", player: "josh allen", playerDisplay: "Josh Allen", canon: "pass_yds",
    line: 245.5, book: "DraftKings", bookKey: "draftkings", over: -110, under: -110, ...over,
  };
}

describe("odds math", () => {
  it("converts American odds", () => {
    assert.equal(americanToProb(-110).toFixed(4), "0.5238");
    assert.equal(americanToProb(+150).toFixed(4), "0.4000");
    assert.equal(probToAmerican(0.6), -150);
  });
  it("devigs: the juiced side is the favorite (the +113 / −98 example)", () => {
    const pOver = devigTwoWay(113, -98)!;
    assert.ok(pOver < 0.5, "over at +113 is the underdog");
    assert.ok(Math.abs(pOver - 0.4867) < 0.002);
  });
  it("3-pick power breakeven is 55.03% at 6x and 58.48% at 5x", () => {
    assert.equal(breakevenPerLeg(3, 6).toFixed(4), "0.5503");
    assert.equal(breakevenPerLeg(3, 5).toFixed(4), "0.5848");
  });
  it("line shift moves probability the right way", () => {
    // Book: 50/50 at 250.5 → at PrizePicks 245.5 the over is more likely.
    assert.ok(shiftPOver(0.5, 250.5, 245.5, 70) > 0.5);
    assert.ok(shiftPOver(0.5, 240.5, 245.5, 70) < 0.5);
  });
});

describe("stat + name normalization", () => {
  it("maps PrizePicks labels", () => {
    assert.equal(canonicalStat("NFL", "Rec Yards"), "rec_yds");
    assert.equal(canonicalStat("NBA", "Pts+Rebs+Asts"), "pra");
    assert.equal(canonicalStat("NBA", "3-PT Made"), "threes");
    assert.equal(canonicalStat("NBA1Q", "Points"), null);
  });
  it("normalizes names", () => {
    assert.equal(normPlayer("Kenneth Walker III"), "kenneth walker");
    assert.equal(normPlayer("Amon-Ra St. Brown"), "amon ra st brown");
    assert.equal(normPlayer("Janelle Salaün"), "janelle salaun");
  });
});

describe("Odds API parsing", () => {
  it("pairs over/under per player and line", () => {
    const q = parseEventOdds("NFL", {
      bookmakers: [{
        key: "fanduel", title: "FanDuel",
        markets: [{ key: "player_pass_yds", outcomes: [
          { name: "Over", description: "Josh Allen", price: -125, point: 245.5 },
          { name: "Under", description: "Josh Allen", price: -105, point: 245.5 },
          { name: "Over", description: "Tua Tagovailoa", price: -110, point: 230.5 }, // unpaired → dropped
        ] }],
      }],
    });
    assert.equal(q.length, 1);
    assert.equal(q[0].canon, "pass_yds");
    assert.equal(q[0].over, -125);
    assert.equal(q[0].under, -105);
  });
});

describe("pricing", () => {
  it("picks the side the books favor", () => {
    const props = [mkProp({})];
    const quotes = [quote({ over: +113, under: -140 }), quote({ book: "FanDuel", bookKey: "fanduel", over: +105, under: -130 })];
    const [p] = priceProps(props, quotes, new Map());
    assert.equal(p.tier, "market");
    assert.equal(p.side, "less");
    assert.ok(p.p > 0.54);
    assert.equal(p.marketCount, 2);
  });
  it("uses Kalshi alone when no book has the prop", () => {
    const props = [mkProp({ id: "pp-2" })];
    const k = new Map([["pp-2", { pYes: 0.6, threshold: 246, marketTicker: "KX", confidence: 0.8, spread: 0.04 }]]);
    const [p] = priceProps(props, [], k);
    assert.equal(p.tier, "market");
    assert.equal(p.side, "more");
    assert.equal(p.p.toFixed(2), "0.60");
  });
  it("skips goblins/demons and started games", () => {
    assert.equal(isEligible(mkProp({ oddsType: "demon" })), false);
    assert.equal(isEligible(mkProp({ gameTime: new Date(Date.now() - 60_000).toISOString() })), false);
  });
  it("discovers Kalshi series by title and ignores career markets", () => {
    const idx = buildKalshiSeriesIndex([
      { ticker: "KXNFLPASSYDS", title: "Pro Football: Passing Yards" },
      { ticker: "KXNFLCAREERPASSYDS", title: "Career Passing Yards" },
      { ticker: "KXNBATOTAL", title: "Pro Basketball: Total Points" },
    ]);
    assert.equal(idx.get("NFL|pass_yds"), "KXNFLPASSYDS");
    assert.equal(idx.get("NBA|points"), "KXNBAPTS"); // static map wins, total ignored
  });
});

describe("slate builder", () => {
  // 12 players × 3 stats = 36 props across 4 teams.
  const stats = ["Pass Yards", "Rush Yards", "Receptions"];
  const teams = ["BUF", "MIA", "KC", "DEN"];
  const props: Prop[] = [];
  let i = 0;
  for (let pl = 0; pl < 12; pl++) {
    for (const st of stats) {
      props.push(mkProp({
        id: `pp-${i++}`, playerName: `Player ${pl}`, team: teams[pl % 4], opponent: teams[(pl + 1) % 4],
        statType: st, pMore: 0.52 + (i % 7) / 100, modelVersion: "training-v2",
      }));
    }
  }
  const ranked = rankPicks(priceProps(props, [], new Map()));

  it("always builds 10 lineups of 3", () => {
    const s = buildSlate(ranked, { count: 10, legs: 3, multiplier: 6 });
    assert.equal(s.lineups.length, 10);
    for (const l of s.lineups) assert.equal(l.picks.length, 3);
    assert.equal(s.shortfall, undefined);
  });

  it("never repeats a pick across the slate; same player with a different stat is allowed", () => {
    const s = buildSlate(ranked);
    const keys = s.lineups.flatMap((l) => l.picks.map((p) => p.uniqueKey));
    assert.equal(new Set(keys).size, 30);
    assert.deepEqual(s.duplicateCheck.repeatedKeys, []);
    const players = s.lineups.flatMap((l) => l.picks.map((p) => p.prop.playerName));
    assert.ok(new Set(players).size < 30, "some player appears with a different stat");
  });

  it("follows PrizePicks entry rules inside a lineup", () => {
    const s = buildSlate(ranked);
    for (const l of s.lineups) {
      assert.equal(new Set(l.picks.map((p) => p.prop.playerName)).size, 3);
      assert.ok(new Set(l.picks.map((p) => p.prop.team)).size >= 2);
    }
  });

  it("dedupes identical player+stat rows (e.g. the same prop listed twice)", () => {
    const dupes = rankPicks(priceProps([...props, { ...props[0], id: "pp-dup" }], [], new Map()));
    const s = buildSlate(dupes);
    assert.deepEqual(s.duplicateCheck.repeatedKeys, []);
  });

  it("reports a shortfall instead of repeating picks on a thin board", () => {
    const s = buildSlate(ranked.slice(0, 7));
    assert.equal(s.lineups.length, 2);
    assert.ok(s.shortfall);
  });

  it("computes EV at the chosen multiplier", () => {
    const s = buildSlate(ranked, { multiplier: 5 });
    const l = s.lineups[0];
    assert.ok(Math.abs(l.evPerDollar - (5 * l.hitProb - 1)) < 1e-12);
  });
});
