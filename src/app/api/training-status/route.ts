import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { allAdapters } from "@/lib/sports/registry";
import "@/lib/sports/registerAll";

export const dynamic = "force-dynamic";

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

interface PerSportStatus {
  lastRunAt: string | null;
  lastRunResult: "ok" | "failed" | "unknown";
  ageHours: number | null;
  freshness: "fresh" | "stale" | "missing";  // green / yellow / red
}

export async function GET() {
  const root = "data/training";
  const lastTrained = (await readJsonOrNull<Record<string, string>>(join(root, "meta", "lastTrainedAt.json"))) ?? {};
  const runHistory = (await readJsonOrNull<unknown[]>(join(root, "meta", "runHistory.json"))) ?? [];
  const currentRun = await readJsonOrNull<unknown>(join(root, "meta", "currentRun.json"));
  const adapters = allAdapters();

  const perSport: Record<string, PerSportStatus> = {};
  for (const a of adapters) {
    const sportKey = a.leagues[0].toLowerCase();
    const ts = lastTrained[a.leagues[0]] ?? lastTrained[sportKey] ?? null;
    const ageHours = ts ? (Date.now() - new Date(ts).getTime()) / 3_600_000 : null;
    perSport[a.displayName] = {
      lastRunAt: ts,
      lastRunResult: ts ? "ok" : "unknown",
      ageHours,
      freshness: ageHours == null ? "missing" : ageHours < 36 ? "fresh" : "stale",
    };
  }
  return NextResponse.json({
    currentlyRunning: currentRun != null,
    runHistoryCount: Array.isArray(runHistory) ? runHistory.length : 0,
    perSport,
  });
}
