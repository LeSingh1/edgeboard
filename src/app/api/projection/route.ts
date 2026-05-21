import { NextResponse } from "next/server";
import { projectionFor } from "@/lib/realProjections";
import type { Prop } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST body: { prop: Prop, ballDontLieKey?: string }
 *
 * Key precedence:
 *   1. body.ballDontLieKey  (set via /settings UI)
 *   2. process.env.BALLDONTLIE_API_KEY  (from .env.local — survives browser refresh)
 *   3. none → falls back to PrizePicks-implied
 *
 * Returns: ProjectionResult — see realProjections.ts
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const prop = body.prop as Prop;
    if (!prop)
      return NextResponse.json({ available: false, reason: "Missing prop" }, { status: 400 });
    const result = await projectionFor(prop);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { available: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
