import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SportArtifacts } from "./types";

const DEFAULT_ROOT = "data/training/artifacts";

interface CacheEntry {
  artifacts: SportArtifacts;
  // Highest mtime across all artifact files we read.
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

const EMPTY_ARTIFACTS: SportArtifacts = {
  calibration: null,
  defenseRatings: null,
  breakoutProfiles: null,
  gameScriptProfile: null,
  metadata: { trainedAt: "", sampleSize: 0, version: "" },
};

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const txt = await readFile(path, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

async function statMs(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Load (or return cached) artifacts for a sport. Cache is invalidated by
 * comparing metadata.json's mtime — the training pipeline always writes
 * metadata last, so a newer mtime there means the artifact set has been
 * atomically swapped and we should re-read.
 */
export async function loadArtifactsForSport(
  sport: string,
  root: string = DEFAULT_ROOT,
): Promise<SportArtifacts> {
  const dir = join(root, sport);
  const metaPath = join(dir, "metadata.json");
  const currentMtime = await statMs(metaPath);

  const cached = cache.get(sport);
  if (cached && cached.mtime === currentMtime && currentMtime > 0) {
    return cached.artifacts;
  }

  if (currentMtime === 0) {
    cache.set(sport, { artifacts: EMPTY_ARTIFACTS, mtime: 0 });
    return EMPTY_ARTIFACTS;
  }

  const [calibration, defenseRatings, breakoutProfiles, gameScriptProfile, metadata] = await Promise.all([
    readJson<SportArtifacts["calibration"]>(join(dir, "calibration.json")),
    readJson<SportArtifacts["defenseRatings"]>(join(dir, "defenseRatings.json")),
    readJson<SportArtifacts["breakoutProfiles"]>(join(dir, "breakoutProfiles.json")),
    readJson<SportArtifacts["gameScriptProfile"]>(join(dir, "gameScriptProfile.json")),
    readJson<SportArtifacts["metadata"]>(metaPath),
  ]);

  const artifacts: SportArtifacts = {
    calibration,
    defenseRatings,
    breakoutProfiles,
    gameScriptProfile,
    metadata: metadata ?? EMPTY_ARTIFACTS.metadata,
  };
  cache.set(sport, { artifacts, mtime: currentMtime });
  return artifacts;
}

export function _resetArtifactCache(): void {
  cache.clear();
}
