/**
 * Optional Claude-powered enrichment of the matchup intel.
 *
 * The heuristic parser handles ~80% of value for free. Claude makes it sharper
 * by reading the full article context — catching things like "Mitchell torched
 * the Knicks for 43 last meeting" that a keyword regex would miss.
 *
 * Triggered only when the user has an anthropicKey set in Settings. If no key,
 * the intel route skips this step and returns just the heuristic signals.
 */

import type { NewsItem } from "@/lib/espnNews";
import type { IntelSignal } from "@/lib/heuristicIntel";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

/**
 * Send the news + matchup context to Claude and ask for grading factors.
 * Returns an empty array on any failure — caller falls back to heuristics.
 */
export async function claudeMatchupSignals(args: {
  playerName: string;
  statType: string;
  line: number;
  opponent?: string;
  news: NewsItem[];
  apiKey: string;
}): Promise<IntelSignal[]> {
  const { playerName, statType, line, opponent, news, apiKey } = args;
  if (news.length === 0 || !apiKey) return [];

  const newsBlob = news
    .slice(0, 10)
    .map((n, i) => `${i + 1}. ${n.headline}\n   ${n.description}`)
    .join("\n\n");

  const prompt = `You are a sports analyst grading a PrizePicks projection. The user is betting MORE on:

PLAYER: ${playerName}
STAT: ${statType}
LINE: ${line}
OPPONENT: ${opponent || "—"}

Recent news headlines + descriptions:

${newsBlob}

Read these and extract any GRADING FACTORS that would shift the expected probability that ${playerName} will go OVER the line. Things to look for:
- Injuries (player or teammates)
- Recent press conference quotes signaling motivation, beef, or trash talk
- Historical performance vs this opponent
- Rest, load management, back-to-back
- Coaching decisions, lineup changes
- Defensive matchup details (specific defender quality)
- Anything else that meaningfully changes the projection

Return STRICT JSON with an array "signals", each with fields:
- label: short category (max 30 chars), e.g. "vs Knicks history", "Hamstring tweak"
- direction: "positive" | "negative" | "neutral"
- magnitude: estimated pMore swing absolute, 0.02-0.15
- confidence: 0..1 (how reliable is this signal)
- evidence: one-sentence quote/explanation from the news

Only include signals supported by the news above. If nothing meaningful, return {"signals": []}.

Respond with JSON only, no prose.`;

  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: "user" as const, content: prompt } as ClaudeMessage],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as ClaudeResponse;
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    // Extract JSON — Claude usually returns clean JSON, but be defensive
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as {
      signals?: Array<{
        label?: string;
        direction?: string;
        magnitude?: number;
        confidence?: number;
        evidence?: string;
      }>;
    };
    const out: IntelSignal[] = [];
    for (const s of parsed.signals ?? []) {
      if (!s.label || !s.evidence) continue;
      const dir = s.direction === "positive" || s.direction === "negative" || s.direction === "neutral"
        ? s.direction
        : "neutral";
      out.push({
        label: s.label.slice(0, 30),
        direction: dir,
        magnitude: Math.max(0.02, Math.min(0.15, Number(s.magnitude) || 0.05)),
        confidence: Math.max(0.1, Math.min(0.9, Number(s.confidence) || 0.5)),
        evidence: s.evidence.slice(0, 200),
        source: "claude",
      });
    }
    return out;
  } catch {
    return [];
  }
}
