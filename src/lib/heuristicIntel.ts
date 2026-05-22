/**
 * Heuristic intel parser — scans news headlines + descriptions for keyword
 * signals that affect a player's expected stat output. No LLM needed; pure
 * regex/keyword matching, fast, free, no key.
 *
 * Each signal carries a direction (positive/negative for MORE) and a confidence
 * weight. The matchup-intel engine combines these with the statistical
 * adjustments to compute the final probability.
 */

import type { NewsItem } from "@/lib/espnNews";

export type IntelDirection = "positive" | "negative" | "neutral";

export interface IntelSignal {
  /** Short category label shown in the UI: "Injury", "Rest", "Beef", "Momentum", ... */
  label: string;
  direction: IntelDirection;
  /** Magnitude estimate as a pMore swing — small (0.02), medium (0.05), big (0.10) */
  magnitude: number;
  /** Confidence in this signal (0..1). Heuristic max is 0.5; Claude can push higher. */
  confidence: number;
  /** Short quote / description shown to the user */
  evidence: string;
  /** "espn-headline" | "espn-article" | "claude" — for provenance tracking */
  source: string;
}

// ────────────────────────────────────────────────────────────────────────
// Keyword rules — each rule has a regex, direction, magnitude, confidence
// and a category label. Order matters slightly: more specific rules first.
// ────────────────────────────────────────────────────────────────────────

interface KeywordRule {
  category: string;
  pattern: RegExp;
  direction: IntelDirection;
  magnitude: number;
  confidence: number;
}

const RULES: KeywordRule[] = [
  // ── Hard injury signals ─────────────────────────────────────────────
  {
    category: "Injury · OUT",
    pattern: /\b(out|ruled out|will not play|sidelined|inactive|misses?)\b/i,
    direction: "negative",
    magnitude: 0.4,
    confidence: 0.5,
  },
  {
    category: "Injury · doubtful",
    pattern: /\b(doubtful|game[\s-]?time decision|questionable)\b/i,
    direction: "negative",
    magnitude: 0.12,
    confidence: 0.4,
  },
  {
    category: "Injury · banged up",
    // Require the injury context — these phrases are specific to a player
    // being banged up (won't false-match generic uses of "back", "core", etc.)
    pattern: /\b(injur(y|ed)|tweaked|tender|sore (ankle|knee|hamstring|groin|shoulder|wrist|elbow|back|foot|hip)|hamstring (strain|tear|tightness|injury)|sprained|knee injury|ankle injury|back injury|back tightness|day[\s-]to[\s-]day|out indefinitely)\b/i,
    direction: "negative",
    magnitude: 0.05,
    confidence: 0.3,
  },
  {
    category: "Status · upgraded",
    pattern: /\b(upgraded|cleared|expected to play|will play|return(s|ing)?)\b/i,
    direction: "positive",
    magnitude: 0.04,
    confidence: 0.35,
  },
  // ── Rest / load management ──────────────────────────────────────────
  {
    category: "Rest",
    pattern: /\b(rest(ed|ing)?|load management|day off|second of back[\s-]?to[\s-]?back|sat out)\b/i,
    direction: "negative",
    magnitude: 0.06,
    confidence: 0.3,
  },
  // ── Hot/cold streaks ────────────────────────────────────────────────
  {
    category: "Hot streak",
    pattern: /\b(career[\s-]?high|season[\s-]?high|breakout|on fire|red[\s-]?hot|dominant|takeover)\b/i,
    direction: "positive",
    magnitude: 0.04,
    confidence: 0.25,
  },
  {
    category: "Cold streak",
    pattern: /\b(slump|struggling|cold|off night|rough|worst|lowest)\b/i,
    direction: "negative",
    magnitude: 0.04,
    confidence: 0.25,
  },
  // ── Motivation / beef / narrative ───────────────────────────────────
  {
    category: "Revenge / motivation",
    pattern: /\b(revenge game|chip on (his|her) shoulder|silenc(e|ed|ing)|critics|prove (himself|herself)|fueled by|disrespect(ed)?)\b/i,
    direction: "positive",
    magnitude: 0.05,
    confidence: 0.3,
  },
  {
    category: "Beef / rivalry",
    pattern: /\b(beef|feud|trash talk|exchanged words|altercation|rivalry|bad blood|war of words)\b/i,
    direction: "positive",
    magnitude: 0.04,
    confidence: 0.25,
  },
  {
    category: "Confidence",
    pattern: /\b(confident|locked in|in the zone|feeling great|ready|primed|attack mode)\b/i,
    direction: "positive",
    magnitude: 0.03,
    confidence: 0.2,
  },
  // ── Team / lineup context ───────────────────────────────────────────
  {
    category: "Teammate out",
    pattern: /\b(without|missing|sidelined.+teammate|absence of|workload increase|primary scorer)\b/i,
    direction: "positive",
    magnitude: 0.06,
    confidence: 0.35,
  },
  {
    category: "Stacked opponent D",
    pattern: /\b(elite defense|top defense|lockdown|defensive specialist|best defender)\b/i,
    direction: "negative",
    magnitude: 0.04,
    confidence: 0.3,
  },
  {
    category: "Weak opponent D",
    pattern: /\b(weak defense|worst defense|porous|gives up|allows the most|bottom defense)\b/i,
    direction: "positive",
    magnitude: 0.04,
    confidence: 0.3,
  },
];

/**
 * Run all keyword rules across the news items. Returns deduped signals —
 * if the same category fires multiple times, take the max-confidence one.
 *
 * Pass the player's name so player-specific signals (injury, motivation)
 * only fire when the player is named in the article — avoids false positives
 * where generic league coverage mentions "back" or "injury" about someone else.
 */
export function extractHeuristicSignals(news: NewsItem[], playerName?: string): IntelSignal[] {
  const bestByCategory = new Map<string, IntelSignal>();
  // Use last name + first name initial as the relevance check
  const playerKeys = playerName
    ? [
        playerName.toLowerCase(),
        playerName.toLowerCase().split(/\s+/).slice(-1)[0], // last name only
      ].filter((k) => k.length >= 4)
    : [];

  for (const item of news) {
    const blob = `${item.headline}. ${item.description}`;
    const blobLower = blob.toLowerCase();
    // Player-specific signals (injury, motivation, hot/cold) only count when
    // the player is named. Team-context signals (Weak D, Teammate out) can
    // fire on any matchup-relevant article.
    const aboutPlayer =
      playerKeys.length === 0 || playerKeys.some((k) => blobLower.includes(k));

    for (const rule of RULES) {
      if (!rule.pattern.test(blob)) continue;
      // Player-specific categories require the article be about this player
      const isPlayerSpecific = /^(Injury|Hot streak|Cold streak|Confidence|Revenge|Rest|Status)/i.test(
        rule.category,
      );
      if (isPlayerSpecific && !aboutPlayer) continue;

      const match = rule.pattern.exec(blob);
      const idx = match?.index ?? 0;
      const evidence = blob
        .slice(Math.max(0, idx - 40), Math.min(blob.length, idx + 100))
        .replace(/\s+/g, " ")
        .trim();
      const conf = rule.confidence * (item.recent ? 1 : 0.7);
      const signal: IntelSignal = {
        label: rule.category,
        direction: rule.direction,
        magnitude: rule.magnitude,
        confidence: Math.min(0.5, conf),
        evidence: `"${evidence}..."`,
        source: "espn-headline",
      };
      const existing = bestByCategory.get(rule.category);
      if (!existing || signal.confidence > existing.confidence) {
        bestByCategory.set(rule.category, signal);
      }
    }
  }
  return Array.from(bestByCategory.values());
}

/** Combine signals into a single pMore swing (signed). */
export function combinedSwing(signals: IntelSignal[]): number {
  let swing = 0;
  for (const s of signals) {
    const dir = s.direction === "negative" ? -1 : s.direction === "positive" ? 1 : 0;
    swing += dir * s.magnitude * s.confidence;
  }
  // Clamp to ±0.25 so a few keywords can't move the needle more than 25%
  return Math.max(-0.25, Math.min(0.25, swing));
}
