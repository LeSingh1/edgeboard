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
  sampleSize: number;       // total synthetic picks in the deployed artifact
  trainSampleSize: number;  // train split (0 on old v1 artifacts)
  testSampleSize: number;   // held-out test split (0 on old v1 artifacts)
}

interface ArtifactMeta {
  sampleSize?: number;
  trainSampleSize?: number;
  testSampleSize?: number;
}

export async function GET() {
  const root = "data/training";
  const lastTrained = (await readJsonOrNull<Record<string, string>>(join(root, "meta", "lastTrainedAt.json"))) ?? {};
  const runHistory = (await readJsonOrNull<unknown[]>(join(root, "meta", "runHistory.json"))) ?? [];
  const currentRun = await readJsonOrNull<unknown>(join(root, "meta", "currentRun.json"));
  const adapters = allAdapters();

  const perSport: Record<string, PerSportStatus> = {};
  let totalSampleSize = 0;
  let totalTrainSampleSize = 0;
  let totalTestSampleSize = 0;

  for (const a of adapters) {
    const sportKey = a.leagues[0].toLowerCase();
    const ts = lastTrained[a.leagues[0]] ?? lastTrained[sportKey] ?? null;
    const ageHours = ts ? (Date.now() - new Date(ts).getTime()) / 3_600_000 : null;

    // Read the deployed artifact to surface its real sample counts.
    const meta = await readJsonOrNull<ArtifactMeta>(join(root, "artifacts", sportKey, "metadata.json"));
    const sampleSize = meta?.sampleSize ?? 0;
    const trainSampleSize = meta?.trainSampleSize ?? 0;
    const testSampleSize = meta?.testSampleSize ?? 0;
    totalSampleSize += sampleSize;
    totalTrainSampleSize += trainSampleSize;
    totalTestSampleSize += testSampleSize;

    perSport[a.displayName] = {
      lastRunAt: ts,
      lastRunResult: ts ? "ok" : "unknown",
      ageHours,
      freshness: ageHours == null ? "missing" : ageHours < 36 ? "fresh" : "stale",
      sampleSize,
      trainSampleSize,
      testSampleSize,
    };
  }
  return NextResponse.json({
    currentlyRunning: currentRun != null,
    runHistoryCount: Array.isArray(runHistory) ? runHistory.length : 0,
    totalSampleSize,
    totalTrainSampleSize,
    totalTestSampleSize,
    perSport,
  });
}
