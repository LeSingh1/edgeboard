import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Autopilot chat — natural-language INTENT PARSER.
 *
 * The chat used to read the user's request with brittle regexes ("$10",
 * "3-pick", "goblins") and gave up the moment phrasing drifted ("2 per
 * lineup", "no overlapping"). This route hands the message + conversation to
 * Claude and gets back a STRUCTURED intent. The model only interprets the
 * request — it never invents picks or probabilities. The client then runs the
 * deterministic optimizer (`buildAutoLineups`) over that intent, so the real
 * model + the no-mock gate still produce every actual pick.
 *
 * Auth: the user's Anthropic key (Settings) is passed in the body; falls back
 * to ANTHROPIC_API_KEY. Same pattern as /api/intel (claudeIntel.ts).
 */

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

interface Body {
  message: string;
  history?: ChatTurn[];
  anthropicKey?: string;
  /** Leagues that have a real projection model (the only ones picks can use). */
  sports?: string[];
  propsAvailable?: number;
  /** The user's Max-Spend cap from settings, if any. */
  maxBudget?: number;
}

/** Forced response shape. Sentinels (0 / "") stand in for "not specified" so
 *  the schema stays simple (json_schema rejects min/max + nullable unions). */
const INTENT_SCHEMA = {
  type: "object",
  properties: {
    budget: { type: "number", description: "Total dollars to wager. 0 if the user has not stated a budget yet." },
    intent: { type: "string", enum: ["safe", "lottery", "balanced"], description: "safe = many small high-hit slips; lottery = one big longshot; balanced = in between." },
    sport: { type: "string", description: "Single league in UPPERCASE (NBA, WNBA, MLB, NHL, NFL) if the user named one, else empty string for any." },
    oddsPreference: { type: "string", enum: ["balanced", "goblin", "demon", "standard"], description: "goblin = green/easier lines; demon = red/harder; standard = plain; balanced = model picks." },
    consistentOnly: { type: "boolean", description: "True if the user wants only consistent / steady / low-variance / safe players." },
    lineupCount: { type: "integer", description: "Number of separate lineups/slips requested, e.g. 10. 0 if unspecified." },
    lineupSize: { type: "integer", description: "Picks per lineup, e.g. 2 for '2 picks each' or '2 per lineup'. 0 if unspecified." },
    noOverlap: { type: "boolean", description: "True if the user wants the lineups to NOT share players (no overlap / independent)." },
    clarifyingQuestion: { type: "string", description: "If a budget is missing or the request is ambiguous, a single short question to ask the user. Empty string if nothing is needed." },
    reply: { type: "string", description: "A short, friendly one-sentence confirmation of what you understood and are building. Empty if asking a clarifying question instead." },
  },
  required: [
    "budget", "intent", "sport", "oddsPreference", "consistentOnly",
    "lineupCount", "lineupSize", "noOverlap", "clarifyingQuestion", "reply",
  ],
  additionalProperties: false,
} as const;

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const apiKey = body.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No key → tell the client to fall back to its local parser.
    return NextResponse.json({ error: "No Anthropic API key configured" }, { status: 401 });
  }

  const sports = (body.sports && body.sports.length ? body.sports : ["NBA", "WNBA", "MLB", "NHL", "NFL"]).join(", ");
  const system =
    "You parse a sports-betting user's plain-English request into a structured plan spec for a PrizePicks autopilot. " +
    "You ONLY interpret intent — you never invent players, picks, lines, or probabilities; a separate model builds the actual picks. " +
    `Only these leagues have a real model and can be played: ${sports}. If the user names another sport, set sport to empty and note it in the reply. ` +
    "Use the FULL conversation to assemble the user's CURRENT complete request: carry over preferences stated in earlier turns (lineup count, picks per lineup, goblins, no-overlap, sport) and update them with the latest message. " +
    "Map phrasing flexibly: 'green goblins' / 'easy lines' → goblin; 'red demons' → demon; 'consistent/steady/safe players' → consistentOnly; '2 picks each' or '2 per lineup' → lineupSize 2; '10 lineups/slips' → lineupCount 10; 'no overlapping' / 'don't repeat players' → noOverlap true. " +
    "If the user has NOT given a dollar budget yet, set budget 0 and put a single short question in clarifyingQuestion (and leave reply empty). Otherwise give a one-sentence reply and leave clarifyingQuestion empty.";

  const messages = [
    ...(body.history ?? []).slice(-8).map((t) => ({ role: t.role, content: t.text })),
    { role: "user" as const, content: body.message },
  ];

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        system,
        messages,
        // Structured output forces valid JSON matching the schema; low effort
        // is plenty for intent extraction and keeps the reply fast.
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: INTENT_SCHEMA },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Anthropic ${res.status}`, detail: detail.slice(0, 300) },
        { status: 502 },
      );
    }

    const data = await res.json();
    const text: string =
      Array.isArray(data.content)
        ? data.content.find((b: { type: string }) => b.type === "text")?.text ?? ""
        : "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Model did not return JSON", raw: text.slice(0, 300) }, { status: 502 });
    }
    return NextResponse.json({ intent: parsed });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "request failed" },
      { status: 502 },
    );
  }
}
