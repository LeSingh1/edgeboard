import { NextResponse } from "next/server";
import { getAllLiveStats } from "@/lib/liveStats";

// Refresh every 60s — boxscores tick in roughly that cadence anyway, and we
// want the client polling to stay cheap.
export const revalidate = 60;

export async function GET() {
  try {
    const live = await getAllLiveStats();
    return NextResponse.json(
      {
        live,
        count: live.length,
        fetchedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: String(err), live: [], count: 0 },
      { status: 500 },
    );
  }
}
