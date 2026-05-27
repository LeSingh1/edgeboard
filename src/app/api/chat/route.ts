import { NextResponse } from "next/server";

/**
 * Auto-Pilot chat endpoint.
 *
 * Takes a free-text user message plus a small slice of board context and
 * returns a friendly reply + a structured `intent` block the page can apply
 * to its controls. Only runs when the user has an Anthropic key in
 * /settings — without one, the page falls back to its local regex parser.
 *
 * We prefill the assistant turn with `{` so Claude always opens with JSON,
 * which is a more reliable extraction path than scanning for braces in
 * free-form prose. The model writes the rest of the object after that.
 */

interface ChatBody {
  apiKey: string;
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  knownSports?: string[];
}

interface ChatReplyShape {
  reply?: string;
  intent?: {
    count?: number;
    size?: number;
    entry?: number;
    sport?: string;
    mode?: "safe" | "balanced" | "aggressive";
    resetAll?: boolean;
  };
}

const MODEL = "claude-haiku-4-5-20251001";

function clampInt(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export async function POST(req: Request) {
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body.apiKey) {
    return NextResponse.json({ error: "no_key" }, { status: 400 });
  }
  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json({ error: "no_message" }, { status: 400 });
  }

  const sports = (body.knownSports ?? []).filter((s) => s && s !== "ALL");

  const system = `You are EdgeBot, the in-app assistant for EdgeBoard — a PrizePicks lineup builder. The user types natural-language requests and you respond with a short, friendly message plus a JSON intent block describing what to build.

You can set these knobs (all optional — only include fields the user actually named or strongly implied):
- count: number of lineups, 1-5
- size: picks per lineup, 2-6
- entry: dollar amount per slip, 1-1000
- sport: one of [${sports.join(", ")}] (case-sensitive), omit for all sports
- mode: "safe" | "balanced" | "aggressive"
- resetAll: true ONLY when the user says "surprise me" / "anything" / "auto everything"

Rules:
- The 'reply' field is what the user reads. Keep it 1-2 short sentences, friendly, no markdown.
- Never invent specific players, stats, or projections. The app picks actual props from PrizePicks based on your intent.
- Smaller 'size' is safer; larger pays more. "Easily win", "safe", "guaranteed" → mode=safe and prefer smaller size.
- If the user asks a general question that isn't a build request (e.g. "what's a goblin?"), reply briefly and omit intent.

Output JSON ONLY. No markdown fences, no extra prose. Shape:
{"reply": "...", "intent": {"count": 3, "size": 4}}`;

  const history = (body.history ?? []).slice(-8).map((h) => ({
    role: h.role,
    content: h.content,
  }));

  const requestBody = {
    model: MODEL,
    max_tokens: 512,
    system,
    messages: [
      ...history,
      { role: "user" as const, content: body.message },
      { role: "assistant" as const, content: "{" },
    ],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": body.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `upstream_${res.status}`, detail: errText.slice(0, 300) },
        { status: 502 },
      );
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    // Prefill prepended a "{" — close-paren the rest. Be defensive about
    // extra prose by extracting the first JSON object.
    const full = "{" + text;
    const m = full.match(/\{[\s\S]*\}/);
    if (!m) {
      return NextResponse.json(
        { error: "no_json", detail: text.slice(0, 200) },
        { status: 500 },
      );
    }
    let parsed: ChatReplyShape;
    try {
      parsed = JSON.parse(m[0]) as ChatReplyShape;
    } catch {
      return NextResponse.json({ error: "parse_fail", detail: m[0].slice(0, 200) }, { status: 500 });
    }

    // Sanitize the intent — clamp ranges, drop bad values rather than
    // trusting the model wholesale. Reply text gets a soft length cap.
    const intent: ChatReplyShape["intent"] = {};
    const i = parsed.intent ?? {};
    const count = clampInt(i.count, 1, 5);
    if (count !== undefined) intent.count = count;
    const size = clampInt(i.size, 2, 6);
    if (size !== undefined) intent.size = size;
    const entry = clampInt(i.entry, 1, 1000);
    if (entry !== undefined) intent.entry = entry;
    if (typeof i.sport === "string" && sports.includes(i.sport)) intent.sport = i.sport;
    if (i.mode === "safe" || i.mode === "balanced" || i.mode === "aggressive") intent.mode = i.mode;
    if (i.resetAll === true) intent.resetAll = true;

    return NextResponse.json({
      reply: (parsed.reply ?? "Okay.").toString().slice(0, 400),
      intent,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
