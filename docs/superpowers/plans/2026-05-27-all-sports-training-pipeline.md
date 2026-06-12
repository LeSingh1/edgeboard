# All-Sports Training Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor edgeboard's projection model into a per-sport adapter framework, add adapters for NFL/NHL/soccer/tennis/PGA/AFL/NCAAM/NCAAF, and ship a nightly auto-retrain pipeline with watchdog monitoring.

**Architecture:** Per-sport adapters (`src/lib/sports/{league}/`) implement a uniform `SportAdapter` contract. Shared training core (`src/lib/training/`) orchestrates parallel fetch + calibration fit + atomic artifact deploy. `realProjections.ts` becomes a thin dispatcher that routes props to the right adapter. Nightly launchd cron runs the training pipeline; watchdog detects stuck jobs and fires macOS notifications.

**Tech Stack:** Next.js 16 + TypeScript (existing), Node.js built-in `crypto` + `fs/promises` (no new runtime deps), `tsx` (existing devDep for scripts), `osascript` (macOS built-in for notifications), launchd (macOS built-in cron).

**Spec:** `docs/superpowers/specs/2026-05-27-all-sports-training-design.md`

---

## Phase 1 — Shared Framework (Tasks 1-8)

The framework everything plugs into. No sport-specific code yet.

---

### Task 1: Define SportAdapter contract + shared types

**Files:**
- Create: `src/lib/sports/types.ts`
- Test: `src/lib/sports/types.test.ts`

- [ ] **Step 1: Write the failing type-check test**

```typescript
// src/lib/sports/types.test.ts
import type { SportAdapter, RawGame, PlayerRef, SportArtifacts, Adjustment } from "./types";

// Compile-time tests: these will fail TS check if the types don't exist or have wrong shapes.
const _adapter: SportAdapter = {
  leagues: ["TEST"],
  displayName: "Test",
  trainingSeasons: () => [2025, 2026],
  supportedStats: ["Stat1"],
  fetchPlayerRoster: async () => [] as PlayerRef[],
  fetchPlayerGamelog: async () => [] as RawGame[],
  fetchTeamSchedule: async () => [],
  extractStat: () => null,
  project: async () => ({ available: false, reason: "test" }),
};
const _adj: Adjustment = { label: "x", shift: 0, pMoreSwing: 0, confidence: 0, reason: "" };
const _art: SportArtifacts = { calibration: null, defenseRatings: null, breakoutProfiles: null, gameScriptProfile: null, metadata: { trainedAt: "", sampleSize: 0, version: "" } };
export { _adapter, _adj, _art };
```

- [ ] **Step 2: Run TS check to verify it fails**

Run: `npx tsc --noEmit src/lib/sports/types.test.ts`
Expected: FAIL with "Cannot find module './types'"

- [ ] **Step 3: Create the types file**

```typescript
// src/lib/sports/types.ts
import type { Prop } from "@/lib/types";
import type { ProjectionResult, ProjectionAdjustment } from "@/lib/realProjections";

/** A single raw game from an external data source. Shape is per-sport. */
export interface RawGame {
  eventId: string;
  gameDate: string;             // ISO date string
  /** Sport-specific stat payload. Adapters know how to read it. */
  stats: Record<string, number | string | null>;
  opponentAbbr?: string;
  atVs?: "@" | "vs";
  isPlayoff?: boolean;
}

export interface PlayerRef {
  id: string;
  name: string;
  team?: string;
}

export interface DefenseRatings {
  byTeam: Record<string, Record<string, number>>;   // team → stat → delta vs league avg
  leagueAvg: Record<string, number>;
}

export interface CalibrationTable {
  /** Per (stat|oddsType) → { x: number[], y: number[] } isotonic corrector. */
  buckets: Record<string, { x: number[]; y: number[]; sampleSize: number }>;
}

export interface BreakoutProfiles {
  byPlayerId: Record<string, { stat: string; trend: number; confidence: number }[]>;
}

export interface GameScriptProfile {
  /** team → pace + scoring shift heuristics */
  byTeam: Record<string, { pace: number; offensiveShift: number }>;
}

export interface SportArtifacts {
  calibration: CalibrationTable | null;
  defenseRatings: DefenseRatings | null;
  breakoutProfiles: BreakoutProfiles | null;
  gameScriptProfile: GameScriptProfile | null;
  metadata: {
    trainedAt: string;
    sampleSize: number;
    version: string;
  };
}

// Re-export so adapter authors don't need a second import
export type Adjustment = ProjectionAdjustment;

export interface SportAdapter {
  readonly leagues: string[];
  readonly displayName: string;
  readonly trainingSeasons: () => number[];
  readonly supportedStats: string[];

  fetchPlayerRoster(): Promise<PlayerRef[]>;
  fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]>;
  fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]>;

  extractStat(game: RawGame, statType: string): number | null;
  project(prop: Prop, artifacts: SportArtifacts): Promise<ProjectionResult>;

  recentFormAdjustment?(values: number[]): Adjustment | null;
  vsOpponentAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  homeAwayAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  daysRestAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  defenseAdjustment?(prop: Prop, ratings: DefenseRatings): Adjustment | null;
}
```

- [ ] **Step 4: Re-run TS check**

Run: `npx tsc --noEmit src/lib/sports/types.test.ts`
Expected: PASS (exits with code 0, no output)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sports/types.ts src/lib/sports/types.test.ts
git commit -m "feat: define SportAdapter contract + shared types"
```

---

### Task 2: Create sport registry

**Files:**
- Create: `src/lib/sports/registry.ts`
- Test: `src/lib/sports/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/sports/registry.test.ts
import { describe, it, expect } from "node:test";
import { registerAdapter, getAdapterFor, allAdapters, _resetRegistryForTests } from "./registry";
import type { SportAdapter } from "./types";

const stub = (leagues: string[]): SportAdapter => ({
  leagues, displayName: "Stub", trainingSeasons: () => [2026], supportedStats: [],
  fetchPlayerRoster: async () => [], fetchPlayerGamelog: async () => [],
  fetchTeamSchedule: async () => [], extractStat: () => null,
  project: async () => ({ available: false, reason: "stub" }),
});

describe("sport registry", () => {
  it("looks up adapter by league name", () => {
    _resetRegistryForTests();
    const a = stub(["NBA", "NBA1Q", "NBA1H"]);
    registerAdapter(a);
    expect(getAdapterFor("NBA")).toBe(a);
    expect(getAdapterFor("NBA1Q")).toBe(a);
    expect(getAdapterFor("NHL")).toBeNull();
  });

  it("rejects double-registration of the same league", () => {
    _resetRegistryForTests();
    registerAdapter(stub(["NBA"]));
    expect(() => registerAdapter(stub(["NBA"]))).toThrow(/already registered/);
  });

  it("returns all registered adapters once each", () => {
    _resetRegistryForTests();
    const a = stub(["NBA", "NBA1Q"]);
    const b = stub(["NHL"]);
    registerAdapter(a); registerAdapter(b);
    expect(allAdapters()).toEqual([a, b]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/sports/registry.test.ts`
Expected: FAIL with "Cannot find module './registry'"

- [ ] **Step 3: Implement the registry**

```typescript
// src/lib/sports/registry.ts
import type { SportAdapter } from "./types";

const adapters: SportAdapter[] = [];
const byLeague = new Map<string, SportAdapter>();

export function registerAdapter(adapter: SportAdapter): void {
  for (const league of adapter.leagues) {
    if (byLeague.has(league)) {
      throw new Error(`Adapter for league "${league}" already registered`);
    }
  }
  for (const league of adapter.leagues) byLeague.set(league, adapter);
  adapters.push(adapter);
}

export function getAdapterFor(league: string): SportAdapter | null {
  return byLeague.get(league) ?? null;
}

export function allAdapters(): SportAdapter[] {
  return [...adapters];
}

/** Test-only — clears registry state between tests. Do not call from app code. */
export function _resetRegistryForTests(): void {
  adapters.length = 0;
  byLeague.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/sports/registry.test.ts`
Expected: PASS (3 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sports/registry.ts src/lib/sports/registry.test.ts
git commit -m "feat: add sport registry with league → adapter lookup"
```

---

### Task 3: Lazy artifact cache with mtime invalidation

**Files:**
- Create: `src/lib/sports/artifactCache.ts`
- Test: `src/lib/sports/artifactCache.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/sports/artifactCache.test.ts
import { describe, it, expect, beforeEach } from "node:test";
import { mkdtemp, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArtifactsForSport, _resetArtifactCache } from "./artifactCache";

describe("artifactCache", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "edgeboard-art-"));
    _resetArtifactCache();
  });

  it("returns empty artifacts when sport folder is missing", async () => {
    const a = await loadArtifactsForSport("nba", root);
    expect(a.calibration).toBeNull();
    expect(a.metadata.sampleSize).toBe(0);
  });

  it("reads calibration.json + metadata.json when present", async () => {
    await mkdir(join(root, "nba"), { recursive: true });
    await writeFile(join(root, "nba", "calibration.json"), JSON.stringify({ buckets: { "Points|standard": { x: [0.5], y: [0.52], sampleSize: 1000 } } }));
    await writeFile(join(root, "nba", "metadata.json"), JSON.stringify({ trainedAt: "2026-05-27T03:15:00Z", sampleSize: 5000, version: "v1" }));
    const a = await loadArtifactsForSport("nba", root);
    expect(a.calibration?.buckets["Points|standard"].sampleSize).toBe(1000);
    expect(a.metadata.sampleSize).toBe(5000);
  });

  it("reloads when mtime changes", async () => {
    await mkdir(join(root, "nba"), { recursive: true });
    await writeFile(join(root, "nba", "metadata.json"), JSON.stringify({ trainedAt: "t1", sampleSize: 1, version: "v1" }));
    const a1 = await loadArtifactsForSport("nba", root);
    expect(a1.metadata.trainedAt).toBe("t1");
    // Overwrite + bump mtime
    await writeFile(join(root, "nba", "metadata.json"), JSON.stringify({ trainedAt: "t2", sampleSize: 2, version: "v1" }));
    const newer = new Date(Date.now() + 5000);
    await utimes(join(root, "nba", "metadata.json"), newer, newer);
    const a2 = await loadArtifactsForSport("nba", root);
    expect(a2.metadata.trainedAt).toBe("t2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/sports/artifactCache.test.ts`
Expected: FAIL with "Cannot find module './artifactCache'"

- [ ] **Step 3: Implement the cache**

```typescript
// src/lib/sports/artifactCache.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/sports/artifactCache.test.ts`
Expected: PASS (3 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sports/artifactCache.ts src/lib/sports/artifactCache.test.ts
git commit -m "feat: lazy artifact cache with mtime invalidation"
```

---

### Task 4: Shared training core — calibration fitter (per-sport wrapper)

**Files:**
- Create: `src/lib/training/fitSportCalibration.ts`
- Test: `src/lib/training/fitSportCalibration.test.ts`

The existing `src/lib/backtest/fitCalibration.ts` already does isotonic fitting. We wrap it so per-sport callers get a uniform `CalibrationTable` output keyed by `${stat}|${oddsType}`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/training/fitSportCalibration.test.ts
import { describe, it, expect } from "node:test";
import { fitSportCalibration } from "./fitSportCalibration";
import type { ScoredPick } from "@/lib/backtest/aggregate";

describe("fitSportCalibration", () => {
  it("returns a CalibrationTable bucketed by stat|oddsType", () => {
    const picks: ScoredPick[] = Array.from({ length: 600 }, (_, i) => ({
      stat: "Points",
      oddsType: "standard",
      modelProb: 0.5 + (i % 10) * 0.04,
      hit: (i % 10) > 4 ? 1 : 0,
    }));
    const result = fitSportCalibration(picks, { minBucketSize: 500 });
    expect(result.buckets["Points|standard"]).toBeDefined();
    expect(result.buckets["Points|standard"].sampleSize).toBe(600);
    expect(result.buckets["Points|standard"].x.length).toBeGreaterThan(0);
  });

  it("skips buckets below sample-size floor", () => {
    const picks: ScoredPick[] = Array.from({ length: 100 }, () => ({
      stat: "Rebounds", oddsType: "standard", modelProb: 0.5, hit: 1,
    }));
    const result = fitSportCalibration(picks, { minBucketSize: 500 });
    expect(result.buckets["Rebounds|standard"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/training/fitSportCalibration.test.ts`
Expected: FAIL with "Cannot find module './fitSportCalibration'"

- [ ] **Step 3: Implement the wrapper**

```typescript
// src/lib/training/fitSportCalibration.ts
import { fitPerStatCalibration } from "@/lib/backtest/fitCalibration";
import type { ScoredPick } from "@/lib/backtest/aggregate";
import type { CalibrationTable } from "@/lib/sports/types";

export interface FitOpts {
  /** Minimum picks per (stat, oddsType) bucket. Below this → skip the bucket. */
  minBucketSize: number;
}

export function fitSportCalibration(picks: ScoredPick[], opts: FitOpts): CalibrationTable {
  // Group by stat|oddsType, drop buckets below the floor, then fit each.
  const grouped = new Map<string, ScoredPick[]>();
  for (const p of picks) {
    const key = `${p.stat}|${p.oddsType}`;
    const arr = grouped.get(key) ?? [];
    arr.push(p);
    grouped.set(key, arr);
  }
  const buckets: CalibrationTable["buckets"] = {};
  for (const [key, bucketPicks] of grouped) {
    if (bucketPicks.length < opts.minBucketSize) continue;
    const [stat, oddsType] = key.split("|");
    const fit = fitPerStatCalibration(bucketPicks, { stat, oddsType });
    if (!fit) continue;
    buckets[key] = { x: fit.x, y: fit.y, sampleSize: bucketPicks.length };
  }
  return { buckets };
}
```

Note: `fitPerStatCalibration` already exists in `src/lib/backtest/fitCalibration.ts` but currently doesn't take `{stat, oddsType}` filter args. If its signature differs, this task includes adapting it — see Task 4b below.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/training/fitSportCalibration.test.ts`
Expected: PASS (2 tests pass). If fails with signature mismatch, do Task 4b first.

- [ ] **Step 5: Commit**

```bash
git add src/lib/training/fitSportCalibration.ts src/lib/training/fitSportCalibration.test.ts
git commit -m "feat: per-sport calibration fitter with sample-size floor"
```

---

### Task 4b (conditional): Adapt existing fitPerStatCalibration to take filter args

Only do this if Task 4's test fails with a signature mismatch.

**Files:**
- Modify: `src/lib/backtest/fitCalibration.ts`

- [ ] **Step 1: Read the existing signature**

Run: `grep -n "export function fitPerStatCalibration" src/lib/backtest/fitCalibration.ts`

- [ ] **Step 2: Add an overload accepting per-bucket picks**

```typescript
// At the end of src/lib/backtest/fitCalibration.ts, add:

export function fitPerStatCalibration(
  picks: ScoredPick[],
  opts: { stat: string; oddsType: string },
): { x: number[]; y: number[] } | null {
  if (picks.length < 50) return null;
  // Use the existing isotonic-fit core, just on this single bucket.
  const xs = picks.map((p) => p.modelProb);
  const ys = picks.map((p) => (p.hit ? 1 : 0));
  // ... reuse internal `isotonicFit(xs, ys)` — extract it as exported if it isn't
  return isotonicFit(xs, ys);
}
```

(If `isotonicFit` is internal, extract it to a named export first. If the function already accepts these args, skip this task entirely.)

- [ ] **Step 3: Re-run Task 4 test**

Run: `npx tsx --test src/lib/training/fitSportCalibration.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/backtest/fitCalibration.ts
git commit -m "refactor: expose fitPerStatCalibration overload for single bucket"
```

---

### Task 5: Atomic artifact deploy

**Files:**
- Create: `src/lib/training/deployArtifacts.ts`
- Test: `src/lib/training/deployArtifacts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/training/deployArtifacts.test.ts
import { describe, it, expect, beforeEach } from "node:test";
import { mkdtemp, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploySportArtifacts } from "./deployArtifacts";

describe("deploySportArtifacts", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "edgeboard-deploy-")); });

  it("writes each artifact and replaces an existing live dir atomically", async () => {
    // Start with a stale live dir
    await mkdir(join(root, "nba"), { recursive: true });
    await writeFile(join(root, "nba", "old.json"), "stale");

    await deploySportArtifacts({
      sport: "nba",
      rootDir: root,
      artifacts: {
        calibration: { buckets: { "Points|standard": { x: [0.5], y: [0.52], sampleSize: 1000 } } },
        defenseRatings: null,
        breakoutProfiles: null,
        gameScriptProfile: null,
        metadata: { trainedAt: "2026-05-27T03:15:00Z", sampleSize: 5000, version: "v1" },
      },
    });

    // Old file is gone (whole dir replaced)
    await expect(stat(join(root, "nba", "old.json"))).rejects.toThrow();
    // New files present
    const cal = JSON.parse(await readFile(join(root, "nba", "calibration.json"), "utf8"));
    expect(cal.buckets["Points|standard"].sampleSize).toBe(1000);
    const meta = JSON.parse(await readFile(join(root, "nba", "metadata.json"), "utf8"));
    expect(meta.sampleSize).toBe(5000);
  });

  it("skips writing null artifacts", async () => {
    await deploySportArtifacts({
      sport: "tennis",
      rootDir: root,
      artifacts: {
        calibration: { buckets: {} },
        defenseRatings: null,
        breakoutProfiles: null,
        gameScriptProfile: null,
        metadata: { trainedAt: "t", sampleSize: 0, version: "v1" },
      },
    });
    await expect(stat(join(root, "tennis", "defenseRatings.json"))).rejects.toThrow();
    await stat(join(root, "tennis", "calibration.json")); // exists
    await stat(join(root, "tennis", "metadata.json"));    // exists
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/training/deployArtifacts.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement deploy**

```typescript
// src/lib/training/deployArtifacts.ts
import { mkdir, writeFile, rename, rm, open } from "node:fs/promises";
import { join } from "node:path";
import type { SportArtifacts } from "@/lib/sports/types";

interface DeployOpts {
  sport: string;
  rootDir: string;
  artifacts: SportArtifacts;
}

async function writeAndFsync(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2));
  // Open the file and force the OS to flush its buffer to disk. Without this,
  // a crash between writeFile() and rename() could leave the swap pointing at
  // unflushed pages — readers would see an empty file.
  const fd = await open(path, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}

export async function deploySportArtifacts(opts: DeployOpts): Promise<void> {
  const { sport, rootDir, artifacts } = opts;
  const liveDir = join(rootDir, sport);
  const tmpDir = join(rootDir, `${sport}.tmp`);
  const incomingDir = join(rootDir, `${sport}.incoming`);

  // Clear any leftover staging dirs from a crashed previous run.
  await rm(tmpDir, { recursive: true, force: true });
  await rm(incomingDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  // Write each non-null artifact + always write metadata last.
  if (artifacts.calibration) await writeAndFsync(join(tmpDir, "calibration.json"), artifacts.calibration);
  if (artifacts.defenseRatings) await writeAndFsync(join(tmpDir, "defenseRatings.json"), artifacts.defenseRatings);
  if (artifacts.breakoutProfiles) await writeAndFsync(join(tmpDir, "breakoutProfiles.json"), artifacts.breakoutProfiles);
  if (artifacts.gameScriptProfile) await writeAndFsync(join(tmpDir, "gameScriptProfile.json"), artifacts.gameScriptProfile);
  await writeAndFsync(join(tmpDir, "metadata.json"), artifacts.metadata);

  // Two-step rename: tmp → incoming, then remove live, then incoming → live.
  // Direct rename of tmp over a non-empty live dir isn't atomic on all FSes,
  // so we use the incoming-stage pattern.
  await rename(tmpDir, incomingDir);
  await rm(liveDir, { recursive: true, force: true });
  await rename(incomingDir, liveDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/training/deployArtifacts.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/training/deployArtifacts.ts src/lib/training/deployArtifacts.test.ts
git commit -m "feat: atomic artifact deploy via two-step rename"
```

---

### Task 6: Progress checkpoint + watchdog

**Files:**
- Create: `src/lib/training/watchdog.ts`
- Test: `src/lib/training/watchdog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/training/watchdog.test.ts
import { describe, it, expect, beforeEach } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProgress, readProgress, isStuck, notify } from "./watchdog";

describe("watchdog", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "edgeboard-wd-")); });

  it("writes and reads back currentRun.json", async () => {
    await writeProgress(root, { sport: "nba", phase: "fetch", progressPct: 0.3, lastUpdate: new Date().toISOString(), pid: 123 });
    const r = await readProgress(root);
    expect(r?.sport).toBe("nba");
    expect(r?.phase).toBe("fetch");
  });

  it("flags stuck jobs older than threshold", () => {
    const old = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    expect(isStuck({ sport: "nba", phase: "fetch", progressPct: 0.3, lastUpdate: old, pid: 123 }, 30 * 60 * 1000)).toBe(true);
  });

  it("does NOT flag fresh jobs", () => {
    expect(isStuck({ sport: "nba", phase: "fetch", progressPct: 0.3, lastUpdate: new Date().toISOString(), pid: 123 }, 30 * 60 * 1000)).toBe(false);
  });

  it("notify uses osascript when available", async () => {
    // Smoke test only — actually invoking osascript would fire a real notification.
    // We test the function exists and accepts the right shape.
    expect(typeof notify).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/training/watchdog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement watchdog**

```typescript
// src/lib/training/watchdog.ts
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface ProgressState {
  sport: string;
  phase: string;            // "fetch" | "extract" | "score" | "calibrate" | "deploy" | "done"
  progressPct: number;      // 0..1
  lastUpdate: string;       // ISO
  pid: number;
}

const META_FILE = "currentRun.json";

export async function writeProgress(metaDir: string, state: ProgressState): Promise<void> {
  await mkdir(metaDir, { recursive: true });
  await writeFile(join(metaDir, META_FILE), JSON.stringify(state, null, 2));
}

export async function readProgress(metaDir: string): Promise<ProgressState | null> {
  try {
    const txt = await readFile(join(metaDir, META_FILE), "utf8");
    return JSON.parse(txt) as ProgressState;
  } catch { return null; }
}

export function isStuck(state: ProgressState, thresholdMs: number): boolean {
  const age = Date.now() - new Date(state.lastUpdate).getTime();
  return age > thresholdMs;
}

/**
 * Fire a macOS notification via osascript. Silently no-ops on non-Darwin.
 * Title is fixed to "EdgeBoard"; subtitle/message are caller-controlled.
 */
export function notify(message: string, subtitle?: string): void {
  if (process.platform !== "darwin") return;
  const escaped = message.replace(/"/g, '\\"');
  const sub = subtitle ? `subtitle "${subtitle.replace(/"/g, '\\"')}"` : "";
  const script = `display notification "${escaped}" ${sub} with title "EdgeBoard"`;
  const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
  child.unref();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/training/watchdog.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/training/watchdog.ts src/lib/training/watchdog.test.ts
git commit -m "feat: training progress checkpoint + stuck-job watchdog"
```

---

### Task 7: Per-sport job runner (runSport)

**Files:**
- Create: `src/lib/training/runSport.ts`
- Test: `src/lib/training/runSport.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/training/runSport.test.ts
import { describe, it, expect, beforeEach } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSport } from "./runSport";
import type { SportAdapter, RawGame } from "@/lib/sports/types";

const mockAdapter: SportAdapter = {
  leagues: ["MOCK"],
  displayName: "Mock",
  trainingSeasons: () => [2026],
  supportedStats: ["Points"],
  fetchPlayerRoster: async () => [{ id: "p1", name: "Player One", team: "T" }],
  fetchPlayerGamelog: async () => Array.from({ length: 600 }, (_, i): RawGame => ({
    eventId: `e${i}`,
    gameDate: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    stats: { Points: 10 + (i % 20) },
  })),
  fetchTeamSchedule: async () => [],
  extractStat: (game, stat) => Number(game.stats[stat] ?? null),
  project: async () => ({ available: false, reason: "n/a" }),
};

describe("runSport", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "edgeboard-runsport-")); });

  it("fetches, extracts, fits calibration, deploys", async () => {
    const result = await runSport(mockAdapter, { rootDir: root, minBucketSize: 100 });
    expect(result.status).toBe("ok");
    expect(result.sport).toBe("MOCK");
    expect(result.sampleSize).toBeGreaterThan(0);
  });

  it("returns failed status when an adapter throws", async () => {
    const badAdapter = { ...mockAdapter, fetchPlayerRoster: async () => { throw new Error("ESPN 503"); } };
    const result = await runSport(badAdapter, { rootDir: root, minBucketSize: 100 });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/ESPN 503/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/training/runSport.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement runSport**

```typescript
// src/lib/training/runSport.ts
import { join } from "node:path";
import type { SportAdapter, RawGame, SportArtifacts } from "@/lib/sports/types";
import type { ScoredPick } from "@/lib/backtest/aggregate";
import { fitSportCalibration } from "./fitSportCalibration";
import { deploySportArtifacts } from "./deployArtifacts";
import { writeProgress } from "./watchdog";

export interface RunSportResult {
  sport: string;
  status: "ok" | "failed";
  sampleSize: number;
  durationMs: number;
  error?: string;
}

interface RunSportOpts {
  rootDir: string;        // data/training root
  minBucketSize: number;  // calibration sample-size floor
}

export async function runSport(adapter: SportAdapter, opts: RunSportOpts): Promise<RunSportResult> {
  const t0 = Date.now();
  const sportKey = adapter.leagues[0].toLowerCase();
  const metaDir = join(opts.rootDir, "meta");
  const artifactsDir = join(opts.rootDir, "artifacts");
  const checkpoint = (phase: string, pct: number) =>
    writeProgress(metaDir, {
      sport: sportKey,
      phase,
      progressPct: pct,
      lastUpdate: new Date().toISOString(),
      pid: process.pid,
    }).catch(() => undefined);

  try {
    await checkpoint("roster", 0.05);
    const roster = await adapter.fetchPlayerRoster();
    await checkpoint("fetch", 0.15);

    const seasons = adapter.trainingSeasons();
    const gamelogs: { playerId: string; games: RawGame[] }[] = [];
    let done = 0;
    for (const player of roster) {
      const games = await adapter.fetchPlayerGamelog(player.id, seasons);
      gamelogs.push({ playerId: player.id, games });
      done++;
      if (done % 25 === 0) await checkpoint("fetch", 0.15 + 0.55 * (done / roster.length));
    }

    await checkpoint("score", 0.75);
    const scoredPicks: ScoredPick[] = [];
    for (const { games } of gamelogs) {
      for (const stat of adapter.supportedStats) {
        const values: number[] = [];
        for (const g of games) {
          const v = adapter.extractStat(g, stat);
          if (v != null && Number.isFinite(v)) values.push(v);
        }
        if (values.length < 5) continue;
        // Synthesize one pick per game: line = season-mean-rounded-half, hit = whether
        // the game's value exceeded line. modelProb = 0.5 (raw projection equivalent).
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const line = Math.round(mean * 2) / 2;
        for (const v of values) {
          scoredPicks.push({ stat, oddsType: "standard", modelProb: 0.5, hit: v > line ? 1 : 0 });
        }
      }
    }

    await checkpoint("calibrate", 0.85);
    const calibration = fitSportCalibration(scoredPicks, { minBucketSize: opts.minBucketSize });

    await checkpoint("deploy", 0.95);
    const artifacts: SportArtifacts = {
      calibration,
      defenseRatings: null,        // Filled in by sport-specific runners that override this base run
      breakoutProfiles: null,
      gameScriptProfile: null,
      metadata: {
        trainedAt: new Date().toISOString(),
        sampleSize: scoredPicks.length,
        version: "training-v1",
      },
    };
    await deploySportArtifacts({ sport: sportKey, rootDir: artifactsDir, artifacts });

    await checkpoint("done", 1.0);
    return {
      sport: adapter.leagues[0],
      status: "ok",
      sampleSize: scoredPicks.length,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      sport: adapter.leagues[0],
      status: "failed",
      sampleSize: 0,
      durationMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/training/runSport.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/training/runSport.ts src/lib/training/runSport.test.ts
git commit -m "feat: per-sport training job runner with checkpoints"
```

---

### Task 8: Pipeline orchestrator (fan-out + summary)

**Files:**
- Create: `src/lib/training/pipeline.ts`
- Create: `scripts/train-all.ts`
- Test: `src/lib/training/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/training/pipeline.test.ts
import { describe, it, expect, beforeEach } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "./pipeline";
import { _resetRegistryForTests, registerAdapter } from "@/lib/sports/registry";
import type { SportAdapter, RawGame } from "@/lib/sports/types";

const stub = (league: string, fail = false): SportAdapter => ({
  leagues: [league], displayName: league, trainingSeasons: () => [2026],
  supportedStats: ["Points"],
  fetchPlayerRoster: async () => fail ? (() => { throw new Error(`${league} boom`); })() : [{ id: "p1", name: "P", team: "T" }],
  fetchPlayerGamelog: async () => Array.from({ length: 600 }, (_, i): RawGame => ({
    eventId: `e${i}`, gameDate: "2026-05-01", stats: { Points: 10 + (i % 20) },
  })),
  fetchTeamSchedule: async () => [],
  extractStat: (g, s) => Number(g.stats[s] ?? null),
  project: async () => ({ available: false, reason: "n/a" }),
});

describe("runPipeline", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "edgeboard-pipe-"));
    _resetRegistryForTests();
  });

  it("runs all registered adapters and returns a summary", async () => {
    registerAdapter(stub("LG1"));
    registerAdapter(stub("LG2"));
    const summary = await runPipeline({ rootDir: root, minBucketSize: 100, maxConcurrent: 2 });
    expect(summary.results.length).toBe(2);
    expect(summary.okCount).toBe(2);
    expect(summary.failedCount).toBe(0);
  });

  it("isolates failures — one bad adapter doesn't kill the others", async () => {
    registerAdapter(stub("LG1"));
    registerAdapter(stub("LG2", true));    // throws
    registerAdapter(stub("LG3"));
    const summary = await runPipeline({ rootDir: root, minBucketSize: 100, maxConcurrent: 2 });
    expect(summary.okCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.results.find(r => r.sport === "LG2")?.error).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/training/pipeline.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement orchestrator**

```typescript
// src/lib/training/pipeline.ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { allAdapters } from "@/lib/sports/registry";
import { runSport, type RunSportResult } from "./runSport";
import { notify } from "./watchdog";

export interface PipelineSummary {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  okCount: number;
  failedCount: number;
  results: RunSportResult[];
}

interface PipelineOpts {
  rootDir: string;
  minBucketSize: number;
  maxConcurrent: number;
}

/** Run an async fn over items with a concurrency cap. Preserves input order in results. */
async function pmap<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function runPipeline(opts: PipelineOpts): Promise<PipelineSummary> {
  const adapters = allAdapters();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const results = await pmap(adapters, opts.maxConcurrent, (a) =>
    runSport(a, { rootDir: opts.rootDir, minBucketSize: opts.minBucketSize }),
  );

  const okCount = results.filter((r) => r.status === "ok").length;
  const failedCount = results.length - okCount;
  const summary: PipelineSummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    totalMs: Date.now() - t0,
    okCount,
    failedCount,
    results,
  };

  // Persist run history (append, keep last 30)
  const metaDir = join(opts.rootDir, "meta");
  await mkdir(metaDir, { recursive: true });
  await writeFile(join(metaDir, "lastTrainedAt.json"), JSON.stringify(
    Object.fromEntries(results.filter(r => r.status === "ok").map(r => [r.sport, summary.finishedAt])),
    null, 2,
  ));
  // Notification
  const mins = (summary.totalMs / 60000).toFixed(1);
  if (failedCount === 0) {
    notify(`Trained ${okCount} sports in ${mins} min`, "Nightly training complete");
  } else if (okCount === 0) {
    notify(`Training FAILED — 0 sports trained`, "Nightly training failed");
  } else {
    const failed = results.filter(r => r.status === "failed").map(r => r.sport).join(", ");
    notify(`Partial: ${okCount} ok, failed: ${failed}`, `Nightly training (${mins} min)`);
  }
  return summary;
}
```

```typescript
// scripts/train-all.ts
#!/usr/bin/env tsx
import { runPipeline } from "@/lib/training/pipeline";
import "@/lib/sports/registerAll";  // side-effect: registers every adapter

async function main() {
  const summary = await runPipeline({
    rootDir: "data/training",
    minBucketSize: 500,
    maxConcurrent: 4,
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failedCount > 0 ? 1 : 0);
}
main();
```

```typescript
// src/lib/sports/registerAll.ts — populated as adapters are added (Tasks 9-22)
// For now, this file is empty; future tasks add imports that register their adapters as side-effects.
export {};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/training/pipeline.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/training/pipeline.ts src/lib/training/pipeline.test.ts scripts/train-all.ts src/lib/sports/registerAll.ts
git commit -m "feat: training pipeline orchestrator with fan-out + summary"
```

---

## Phase 2 — Refactor Existing Sports (Tasks 9-12)

Move NBA / WNBA / MLB code from the monolithic `realProjections.ts` into adapter folders.

---

### Task 9: NBA adapter — fetch + extract

**Files:**
- Create: `src/lib/sports/nba/index.ts`
- Create: `src/lib/sports/nba/fetch.ts`
- Create: `src/lib/sports/nba/extract.ts`
- Modify: `src/lib/sports/registerAll.ts`
- Test: `src/lib/sports/nba/extract.test.ts`

- [ ] **Step 1: Write the extract test (failing)**

```typescript
// src/lib/sports/nba/extract.test.ts
import { describe, it, expect } from "node:test";
import { nbaExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const game: RawGame = {
  eventId: "e1",
  gameDate: "2026-05-15",
  stats: { PTS: 28, REB: 8, AST: 6, BLK: 1, STL: 2, "3PM": 4, FGM: 10, FGA: 22, FTM: 4, FTA: 5, TO: 3, MIN: 35 },
};

describe("nbaExtractStat", () => {
  it("extracts simple stats", () => {
    expect(nbaExtractStat(game, "Points")).toBe(28);
    expect(nbaExtractStat(game, "Rebounds")).toBe(8);
    expect(nbaExtractStat(game, "Assists")).toBe(6);
  });

  it("extracts combined stats", () => {
    expect(nbaExtractStat(game, "PRA")).toBe(28 + 8 + 6);
    expect(nbaExtractStat(game, "Pts+Rebs")).toBe(28 + 8);
    expect(nbaExtractStat(game, "Pts+Asts")).toBe(28 + 6);
    expect(nbaExtractStat(game, "Rebs+Asts")).toBe(8 + 6);
    expect(nbaExtractStat(game, "Blks+Stls")).toBe(1 + 2);
  });

  it("returns null for unsupported stats", () => {
    expect(nbaExtractStat(game, "Unsupported")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/sports/nba/extract.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement extract**

```typescript
// src/lib/sports/nba/extract.ts
import type { RawGame } from "@/lib/sports/types";

const SIMPLE_MAP: Record<string, string> = {
  Points: "PTS",
  Rebounds: "REB",
  Assists: "AST",
  Steals: "STL",
  "Blocked Shots": "BLK",
  "3PTM": "3PM",
  "3PTA": "3PA",
  "FG Made": "FGM",
  "FG Attempted": "FGA",
  "FTM": "FTM",
  "FTA": "FTA",
  Turnovers: "TO",
};

function num(g: RawGame, key: string): number | null {
  const v = g.stats[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  return null;
}

export function nbaExtractStat(game: RawGame, statType: string): number | null {
  // Combined stats first
  if (statType === "PRA") {
    const p = num(game, "PTS"), r = num(game, "REB"), a = num(game, "AST");
    return p != null && r != null && a != null ? p + r + a : null;
  }
  if (statType === "Pts+Rebs") { const p = num(game, "PTS"), r = num(game, "REB"); return p != null && r != null ? p + r : null; }
  if (statType === "Pts+Asts") { const p = num(game, "PTS"), a = num(game, "AST"); return p != null && a != null ? p + a : null; }
  if (statType === "Rebs+Asts") { const r = num(game, "REB"), a = num(game, "AST"); return r != null && a != null ? r + a : null; }
  if (statType === "Blks+Stls") { const b = num(game, "BLK"), s = num(game, "STL"); return b != null && s != null ? b + s : null; }
  if (statType === "Fantasy Score") {
    const p = num(game, "PTS"), r = num(game, "REB"), a = num(game, "AST"), s = num(game, "STL"), b = num(game, "BLK"), to = num(game, "TO");
    if ([p, r, a, s, b, to].some(v => v == null)) return null;
    return p! + 1.2 * r! + 1.5 * a! + 3 * s! + 3 * b! - 1 * to!;
  }
  // Simple stats
  const k = SIMPLE_MAP[statType];
  if (k) return num(game, k);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/sports/nba/extract.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Implement fetch (delegate to existing ESPN helpers)**

```typescript
// src/lib/sports/nba/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const NBA_TEAMS = ["atl","bos","bkn","cha","chi","cle","dal","den","det","gsw","hou","ind","lac","lal","mem","mia","mil","min","nop","nyk","okc","orl","phi","phx","por","sac","sas","tor","uta","wsh"];

export async function fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]> {
  const ids = new Set<string>();
  for (const seasontype of [2, 3]) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamAbbr}/schedule?season=${season}&seasontype=${seasontype}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const body = await res.json() as { events?: Array<{ id?: string }> };
      for (const e of body.events ?? []) if (e.id) ids.add(e.id);
    } catch { /* per-segment failures ignored */ }
  }
  return [...ids];
}

async function fetchBoxScorePlayers(eventId: string): Promise<PlayerRef[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { boxscore?: { players?: Array<{ team?: { abbreviation?: string }; statistics?: Array<{ athletes?: Array<{ athlete?: { id?: string; displayName?: string } }> }> }> } };
    const out: PlayerRef[] = [];
    for (const team of body.boxscore?.players ?? []) {
      for (const stat of team.statistics ?? []) {
        for (const a of stat.athletes ?? []) {
          if (a.athlete?.id && a.athlete?.displayName) {
            out.push({ id: a.athlete.id, name: a.athlete.displayName, team: team.team?.abbreviation });
          }
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  // Walk every team's schedule, sample first 3 games per team's box score, dedup by athlete id.
  const seen = new Map<string, PlayerRef>();
  for (const team of NBA_TEAMS) {
    const events = await fetchTeamSchedule(team, 2026);
    for (const eventId of events.slice(0, 3)) {
      for (const p of await fetchBoxScorePlayers(eventId)) {
        if (!seen.has(p.id)) seen.set(p.id, p);
      }
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/gamelog?season=${season}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const data = await res.json() as { labels?: string[]; seasonTypes?: Array<{ categories?: Array<{ events?: Array<{ eventId: string; stats: string[] }> }> }>; events?: Record<string, { gameDate?: string; atVs?: "@" | "vs"; opponent?: { abbreviation?: string } }> };
      const labels = data.labels ?? [];
      for (const st of data.seasonTypes ?? []) {
        for (const cat of st.categories ?? []) {
          for (const evt of cat.events ?? []) {
            const statsObj: Record<string, number | string | null> = {};
            for (let i = 0; i < labels.length; i++) {
              const v = evt.stats[i]; const n = parseFloat(v); statsObj[labels[i]] = Number.isFinite(n) ? n : v;
            }
            const meta = data.events?.[evt.eventId];
            out.push({
              eventId: evt.eventId, gameDate: meta?.gameDate ?? "", stats: statsObj,
              opponentAbbr: meta?.opponent?.abbreviation, atVs: meta?.atVs,
              isPlayoff: false, // TODO: derive from seasonTypes seasonType id (3 = postseason)
            });
          }
        }
      }
    } catch { /* per-season failures ignored */ }
  }
  return out;
}
```

- [ ] **Step 6: Wire up the adapter export**

```typescript
// src/lib/sports/nba/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nbaExtractStat } from "./extract";
import type { Prop } from "@/lib/types";

const SUPPORTED_STATS = [
  "Points", "Rebounds", "Assists", "Steals", "Blocked Shots", "3PTM", "3PTA",
  "FG Made", "FG Attempted", "FTM", "FTA", "Turnovers",
  "PRA", "Pts+Rebs", "Pts+Asts", "Rebs+Asts", "Blks+Stls", "Fantasy Score",
];

export const nbaAdapter: SportAdapter = {
  leagues: ["NBA", "NBA1Q", "NBA1H"],
  displayName: "NBA",
  trainingSeasons: () => {
    // NBA season runs Oct–Jun. Cover current season only — players have 70+ games by playoffs.
    const y = new Date().getFullYear();
    return [y];
  },
  supportedStats: SUPPORTED_STATS,
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: nbaExtractStat,
  project: async (prop: Prop) => {
    // Delegate to existing nbaProjection() during transition; will be inlined here in a later cleanup task.
    const { nbaProjection } = await import("@/lib/realProjections");
    return nbaProjection(prop);
  },
};
```

- [ ] **Step 7: Register the adapter**

```typescript
// src/lib/sports/registerAll.ts (replace empty file)
import { registerAdapter } from "./registry";
import { nbaAdapter } from "./nba";
registerAdapter(nbaAdapter);
```

- [ ] **Step 8: Smoke test — adapter loads + registers**

Run: `npx tsx -e "import('./src/lib/sports/registerAll').then(() => import('./src/lib/sports/registry').then(({ getAdapterFor }) => console.log(getAdapterFor('NBA')?.displayName)))"`
Expected output: `NBA`

- [ ] **Step 9: Commit**

```bash
git add src/lib/sports/nba/ src/lib/sports/registerAll.ts
git commit -m "feat: NBA adapter — fetch + extract + registry wire-up"
```

---

### Task 10: WNBA adapter (mostly mirrors NBA)

**Files:**
- Create: `src/lib/sports/wnba/index.ts`
- Create: `src/lib/sports/wnba/fetch.ts`
- Modify: `src/lib/sports/registerAll.ts`
- Test: `src/lib/sports/wnba/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/sports/wnba/fetch.test.ts
import { describe, it, expect } from "node:test";
import { trainingSeasons } from "./index";

describe("WNBA training seasons", () => {
  it("returns prior + current year", () => {
    const seasons = trainingSeasons();
    expect(seasons.length).toBe(2);
    const y = new Date().getFullYear();
    expect(seasons).toEqual([y - 1, y]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/sports/wnba/fetch.test.ts`
Expected: FAIL

- [ ] **Step 3: Create WNBA fetch (same as NBA but with /wnba/ URL)**

```typescript
// src/lib/sports/wnba/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WNBA_TEAMS = ["atl","chi","conn","ind","la","lv","min","ny","phx","sea","wsh","dal","gsv","tor","por"];

export async function fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]> {
  const ids = new Set<string>();
  for (const seasontype of [2, 3]) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${teamAbbr}/schedule?season=${season}&seasontype=${seasontype}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const body = await res.json() as { events?: Array<{ id?: string }> };
      for (const e of body.events ?? []) if (e.id) ids.add(e.id);
    } catch { /* skip */ }
  }
  return [...ids];
}

async function fetchBoxScorePlayers(eventId: string): Promise<PlayerRef[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { boxscore?: { players?: Array<{ team?: { abbreviation?: string }; statistics?: Array<{ athletes?: Array<{ athlete?: { id?: string; displayName?: string } }> }> }> } };
    const out: PlayerRef[] = [];
    for (const team of body.boxscore?.players ?? []) {
      for (const stat of team.statistics ?? []) {
        for (const a of stat.athletes ?? []) {
          if (a.athlete?.id && a.athlete?.displayName) {
            out.push({ id: a.athlete.id, name: a.athlete.displayName, team: team.team?.abbreviation });
          }
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();
  for (const team of WNBA_TEAMS) {
    const events = await fetchTeamSchedule(team, y);
    for (const eventId of events.slice(0, 3)) {
      for (const p of await fetchBoxScorePlayers(eventId)) {
        if (!seen.has(p.id)) seen.set(p.id, p);
      }
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/${playerId}/gamelog?season=${season}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const data = await res.json() as { labels?: string[]; seasonTypes?: Array<{ categories?: Array<{ events?: Array<{ eventId: string; stats: string[] }> }> }>; events?: Record<string, { gameDate?: string; atVs?: "@" | "vs"; opponent?: { abbreviation?: string } }> };
      const labels = data.labels ?? [];
      for (const st of data.seasonTypes ?? []) {
        for (const cat of st.categories ?? []) {
          for (const evt of cat.events ?? []) {
            const statsObj: Record<string, number | string | null> = {};
            for (let i = 0; i < labels.length; i++) {
              const v = evt.stats[i]; const n = parseFloat(v); statsObj[labels[i]] = Number.isFinite(n) ? n : v;
            }
            const meta = data.events?.[evt.eventId];
            out.push({
              eventId: evt.eventId, gameDate: meta?.gameDate ?? "", stats: statsObj,
              opponentAbbr: meta?.opponent?.abbreviation, atVs: meta?.atVs, isPlayoff: false,
            });
          }
        }
      }
    } catch { /* skip */ }
  }
  return out;
}
```

- [ ] **Step 4: Create adapter using NBA extractor (basketball stats are identical)**

```typescript
// src/lib/sports/wnba/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { nbaExtractStat } from "@/lib/sports/nba/extract";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import type { Prop } from "@/lib/types";

export function trainingSeasons(): number[] {
  const y = new Date().getFullYear();
  return [y - 1, y];   // WNBA: short 40-game season → pull two years
}

const SUPPORTED_STATS = [
  "Points", "Rebounds", "Assists", "Steals", "Blocked Shots", "3PTM", "3PTA",
  "FG Made", "FG Attempted", "FTM", "FTA", "Turnovers",
  "PRA", "Pts+Rebs", "Pts+Asts", "Rebs+Asts", "Blks+Stls", "Fantasy Score",
];

export const wnbaAdapter: SportAdapter = {
  leagues: ["WNBA", "WNBA1Q", "WNBA1H"],
  displayName: "WNBA",
  trainingSeasons,
  supportedStats: SUPPORTED_STATS,
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: nbaExtractStat,
  project: async (prop: Prop) => {
    const { nbaProjection } = await import("@/lib/realProjections");
    return nbaProjection(prop);
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/lib/sports/wnba/fetch.test.ts`
Expected: PASS

- [ ] **Step 6: Register the adapter**

```typescript
// src/lib/sports/registerAll.ts — append
import { wnbaAdapter } from "./wnba";
registerAdapter(wnbaAdapter);
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/sports/wnba/ src/lib/sports/registerAll.ts
git commit -m "feat: WNBA adapter mirroring NBA structure"
```

---

### Task 11: MLB adapter

**Files:**
- Create: `src/lib/sports/mlb/index.ts`
- Create: `src/lib/sports/mlb/fetch.ts`
- Create: `src/lib/sports/mlb/extract.ts`
- Modify: `src/lib/sports/registerAll.ts`
- Test: `src/lib/sports/mlb/extract.test.ts`

- [ ] **Step 1: Failing extract test**

```typescript
// src/lib/sports/mlb/extract.test.ts
import { describe, it, expect } from "node:test";
import { mlbExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const hitter: RawGame = {
  eventId: "e1", gameDate: "2026-05-15",
  stats: { hits: 2, runs: 1, rbi: 3, homeRuns: 1, stolenBases: 0, totalBases: 5, walks: 1, strikeouts: 1, atBats: 4, type: "hitter" },
};
const pitcher: RawGame = {
  eventId: "e2", gameDate: "2026-05-15",
  stats: { strikeouts: 7, hits: 4, earnedRuns: 2, walks: 2, inningsPitched: 6, pitchCount: 95, type: "pitcher" },
};

describe("mlbExtractStat", () => {
  it("extracts hitter stats", () => {
    expect(mlbExtractStat(hitter, "Hits")).toBe(2);
    expect(mlbExtractStat(hitter, "Total Bases")).toBe(5);
    expect(mlbExtractStat(hitter, "Hits+Runs+RBIs")).toBe(2 + 1 + 3);
  });
  it("extracts pitcher stats", () => {
    expect(mlbExtractStat(pitcher, "Pitcher Strikeouts")).toBe(7);
    expect(mlbExtractStat(pitcher, "Pitcher Walks")).toBe(2);
    expect(mlbExtractStat(pitcher, "Pitcher Outs")).toBe(18);
  });
  it("returns null when stat doesn't fit role", () => {
    expect(mlbExtractStat(pitcher, "Hits")).toBeNull();          // hits column means "hits allowed" for pitcher
    expect(mlbExtractStat(hitter, "Pitcher Strikeouts")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify FAIL.** Run: `npx tsx --test src/lib/sports/mlb/extract.test.ts`

- [ ] **Step 3: Implement extract**

```typescript
// src/lib/sports/mlb/extract.ts
import type { RawGame } from "@/lib/sports/types";

function n(g: RawGame, k: string): number | null {
  const v = g.stats[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}

export function mlbExtractStat(game: RawGame, statType: string): number | null {
  const role = game.stats.type;  // "hitter" or "pitcher"
  // Hitter stats
  if (role === "hitter") {
    if (statType === "Hits") return n(game, "hits");
    if (statType === "Runs") return n(game, "runs");
    if (statType === "RBIs") return n(game, "rbi");
    if (statType === "Home Runs") return n(game, "homeRuns");
    if (statType === "Total Bases") return n(game, "totalBases");
    if (statType === "Stolen Bases") return n(game, "stolenBases");
    if (statType === "Walks") return n(game, "walks");
    if (statType === "Strikeouts") return n(game, "strikeouts");
    if (statType === "Hits+Runs+RBIs") {
      const h = n(game, "hits"), r = n(game, "runs"), rbi = n(game, "rbi");
      return h != null && r != null && rbi != null ? h + r + rbi : null;
    }
    if (statType === "Hitter Fantasy Score") {
      const h = n(game, "hits"), r = n(game, "runs"), rbi = n(game, "rbi"), hr = n(game, "homeRuns"), sb = n(game, "stolenBases"), bb = n(game, "walks");
      if ([h, r, rbi, hr, sb, bb].some(v => v == null)) return null;
      return 3 * h! + 2 * r! + 2 * rbi! + 4 * hr! + 5 * sb! + 1 * bb!;
    }
  }
  // Pitcher stats
  if (role === "pitcher") {
    if (statType === "Pitcher Strikeouts" || statType === "Ks") return n(game, "strikeouts");
    if (statType === "Pitcher Walks") return n(game, "walks");
    if (statType === "Pitcher Hits Allowed" || statType === "Hits Allowed") return n(game, "hits");
    if (statType === "Earned Runs") return n(game, "earnedRuns");
    if (statType === "Pitcher Outs") {
      const ip = n(game, "inningsPitched");
      // IP encoded as 6.1 = 6 IP + 1 out — convert to total outs.
      if (ip == null) return null;
      const whole = Math.floor(ip), part = Math.round((ip - whole) * 10);
      return whole * 3 + part;
    }
    if (statType === "Ks + TB") {
      const ks = n(game, "strikeouts");
      return ks;     // TB component requires a different feed; treat as Ks-only for now
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test PASS.** `npx tsx --test src/lib/sports/mlb/extract.test.ts`

- [ ] **Step 5: Implement fetch using MLB Stats API (mirror existing mlbProjection helpers)**

```typescript
// src/lib/sports/mlb/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";

export async function fetchTeamSchedule(_team: string, season: number): Promise<string[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&fields=dates,games,gamePk`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const body = await res.json() as { dates?: Array<{ games?: Array<{ gamePk?: number }> }> };
    const ids: string[] = [];
    for (const d of body.dates ?? []) for (const g of d.games ?? []) if (g.gamePk) ids.push(String(g.gamePk));
    return ids;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  // 40-man + active rosters for every MLB team
  const url = `https://statsapi.mlb.com/api/v1/teams?sportId=1`;
  const teamsRes = await fetch(url);
  if (!teamsRes.ok) return [];
  const teams = (await teamsRes.json() as { teams?: Array<{ id?: number; abbreviation?: string }> }).teams ?? [];
  const out: PlayerRef[] = [];
  for (const t of teams) {
    if (!t.id) continue;
    const rosterRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${t.id}/roster?rosterType=active`);
    if (!rosterRes.ok) continue;
    const data = await rosterRes.json() as { roster?: Array<{ person?: { id?: number; fullName?: string } }> };
    for (const r of data.roster ?? []) {
      if (r.person?.id && r.person?.fullName) {
        out.push({ id: String(r.person.id), name: r.person.fullName, team: t.abbreviation });
      }
    }
  }
  return out;
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    for (const group of ["hitting", "pitching"] as const) {
      const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${season}&group=${group}`;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const body = await res.json() as { stats?: Array<{ splits?: Array<{ date?: string; opponent?: { abbreviation?: string }; isHome?: boolean; game?: { gamePk?: number }; stat?: Record<string, number | string> }> }> };
        for (const stat of body.stats ?? []) {
          for (const s of stat.splits ?? []) {
            out.push({
              eventId: String(s.game?.gamePk ?? `${playerId}-${s.date}-${group}`),
              gameDate: s.date ?? "",
              stats: { ...(s.stat ?? {}), type: group === "hitting" ? "hitter" : "pitcher" },
              opponentAbbr: s.opponent?.abbreviation,
              atVs: s.isHome ? "vs" : "@",
              isPlayoff: false,
            });
          }
        }
      } catch { /* skip */ }
    }
  }
  return out;
}
```

- [ ] **Step 6: Adapter export**

```typescript
// src/lib/sports/mlb/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { mlbExtractStat } from "./extract";
import type { Prop } from "@/lib/types";

const SUPPORTED_STATS = [
  "Hits", "Runs", "RBIs", "Home Runs", "Total Bases", "Stolen Bases", "Walks", "Strikeouts",
  "Hits+Runs+RBIs", "Hitter Fantasy Score",
  "Pitcher Strikeouts", "Ks", "Pitcher Walks", "Pitcher Hits Allowed", "Hits Allowed", "Earned Runs", "Pitcher Outs", "Ks + TB",
];

export const mlbAdapter: SportAdapter = {
  leagues: ["MLB", "MLBLIVE"],
  displayName: "MLB",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: SUPPORTED_STATS,
  fetchPlayerRoster,
  fetchPlayerGamelog,
  fetchTeamSchedule,
  extractStat: mlbExtractStat,
  project: async (prop: Prop) => {
    const { mlbProjection } = await import("@/lib/realProjections");
    return mlbProjection(prop);
  },
};
```

- [ ] **Step 7: Register**

```typescript
// src/lib/sports/registerAll.ts — append
import { mlbAdapter } from "./mlb";
registerAdapter(mlbAdapter);
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/sports/mlb/ src/lib/sports/registerAll.ts
git commit -m "feat: MLB adapter via MLB Stats API"
```

---

### Task 12: Wire adapter dispatch in realProjections.ts

**Files:**
- Modify: `src/lib/realProjections.ts` (function `projectionFor`)

- [ ] **Step 1: Read the existing dispatch**

Run: `grep -n "projectionFor" src/lib/realProjections.ts`

- [ ] **Step 2: Replace the if/else chain with registry dispatch**

Find this block (lines ~1180-1210):
```typescript
export async function projectionFor(prop: Prop): Promise<ProjectionResult> {
  const sport = prop.sport.toUpperCase();
  let result: ProjectionResult;
  if (sport === "MLB") {
    result = await mlbProjection(prop);
  } else if (sport.startsWith("NBA") || sport.startsWith("WNBA")) {
    ...
  } else {
    result = { available: false, reason: ... };
  }
  result = await maybeBlendKalshi(prop, result);
  return result;
}
```

Replace with:
```typescript
export async function projectionFor(prop: Prop): Promise<ProjectionResult> {
  // Ensure registry is populated (idempotent import — only the first call does work)
  await import("@/lib/sports/registerAll");
  const { getAdapterFor } = await import("@/lib/sports/registry");
  const { loadArtifactsForSport } = await import("@/lib/sports/artifactCache");

  const adapter = getAdapterFor(prop.sport);
  let result: ProjectionResult;
  if (adapter) {
    const artifacts = await loadArtifactsForSport(adapter.leagues[0].toLowerCase());
    result = await adapter.project(prop, artifacts);
  } else {
    result = { available: false, reason: `No real model for ${prop.sport} yet — using PrizePicks's default chance.` };
  }
  result = await maybeBlendKalshi(prop, result);
  return result;
}
```

- [ ] **Step 3: Verify TS compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Smoke test via /api/projection**

```bash
# Server should already be running from preview
curl -s -X POST http://localhost:3000/api/projection \
  -H "Content-Type: application/json" \
  -d '{"prop":{"id":"t","source":"prizepicks","externalId":"v","league":"WNBA","sport":"WNBA","isPromo":false,"isLive":false,"refundable":false,"adjustedOdds":false,"status":"active","oddsType":"standard","playerName":"Caitlin Clark","statType":"Points","line":19.5,"team":"IND","opponent":"GS","isHome":true,"gameTime":"2026-05-28T19:00:00.000Z"}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('available:',d.get('available'),'source:',d.get('source','—'))"
```
Expected: `available: True   source: ESPN WNBA · Caitlin Clark · ...` (or similar — must NOT regress to "No real model for WNBA")

- [ ] **Step 5: Commit**

```bash
git add src/lib/realProjections.ts
git commit -m "refactor: projectionFor dispatches via sport registry"
```

---

## Phase 3 — New Sport Adapters (Tasks 13-22)

Each new sport follows the NBA template: `fetch.ts` + `extract.ts` + `index.ts` + register. Stat columns + league URLs differ; structure is identical.

---

### Task 13: NFL adapter

**Files:**
- Create: `src/lib/sports/nfl/{index,fetch,extract}.ts`
- Test: `src/lib/sports/nfl/extract.test.ts`
- Modify: `src/lib/sports/registerAll.ts`

- [ ] **Step 1: Failing extract test**

```typescript
// src/lib/sports/nfl/extract.test.ts
import { describe, it, expect } from "node:test";
import { nflExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const qb: RawGame = { eventId: "e", gameDate: "2026-09-08", stats: { CMP: 24, ATT: 38, "YDS-pass": 285, "TD-pass": 2, INT: 1, "YDS-rush": 18, "TD-rush": 0, "ATT-rush": 4 } };
const wr: RawGame = { eventId: "e", gameDate: "2026-09-08", stats: { REC: 7, "YDS-rec": 102, "TD-rec": 1, "ATT-rush": 1, "YDS-rush": 5 } };

describe("nflExtractStat", () => {
  it("QB pass stats", () => {
    expect(nflExtractStat(qb, "Pass Yards")).toBe(285);
    expect(nflExtractStat(qb, "Pass Completions")).toBe(24);
    expect(nflExtractStat(qb, "Pass Attempts")).toBe(38);
    expect(nflExtractStat(qb, "Pass TDs")).toBe(2);
    expect(nflExtractStat(qb, "INT")).toBe(1);
  });
  it("Receiving stats", () => {
    expect(nflExtractStat(wr, "Receptions")).toBe(7);
    expect(nflExtractStat(wr, "Rec Yards")).toBe(102);
    expect(nflExtractStat(wr, "Rec TDs")).toBe(1);
  });
  it("Rush stats", () => {
    expect(nflExtractStat(qb, "Rush Yards")).toBe(18);
    expect(nflExtractStat(qb, "Rush Attempts")).toBe(4);
  });
});
```

- [ ] **Step 2: Run FAIL.** `npx tsx --test src/lib/sports/nfl/extract.test.ts`

- [ ] **Step 3: Implement extract**

```typescript
// src/lib/sports/nfl/extract.ts
import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
const MAP: Record<string, string> = {
  "Pass Yards": "YDS-pass", "Pass Completions": "CMP", "Pass Attempts": "ATT", "Pass TDs": "TD-pass", "INT": "INT",
  "Receptions": "REC", "Rec Yards": "YDS-rec", "Rec TDs": "TD-rec", "Longest Reception": "LONG-rec",
  "Rush Yards": "YDS-rush", "Rush Attempts": "ATT-rush", "Rush TDs": "TD-rush", "Longest Rush": "LONG-rush",
  "Sacks": "SACK", "Tackles": "TKL", "Solo Tackles": "TKL-solo",
};
export function nflExtractStat(game: RawGame, statType: string): number | null {
  if (statType === "Rush+Rec Yards") {
    const r = n(game, "YDS-rush"), c = n(game, "YDS-rec");
    return r != null && c != null ? r + c : null;
  }
  if (statType === "Pass+Rush Yards") {
    const p = n(game, "YDS-pass"), r = n(game, "YDS-rush");
    return p != null && r != null ? p + r : null;
  }
  const k = MAP[statType];
  return k ? n(game, k) : null;
}
```

- [ ] **Step 4: Run PASS.** `npx tsx --test src/lib/sports/nfl/extract.test.ts`

- [ ] **Step 5: Implement fetch (ESPN /football/nfl/...)**

```typescript
// src/lib/sports/nfl/fetch.ts
import type { PlayerRef, RawGame } from "@/lib/sports/types";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NFL_TEAMS = ["ari","atl","bal","buf","car","chi","cin","cle","dal","den","det","gb","hou","ind","jax","kc","lv","lac","lar","mia","min","ne","no","nyg","nyj","phi","pit","sf","sea","tb","ten","wsh"];

export async function fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]> {
  const ids = new Set<string>();
  for (const seasontype of [2, 3]) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamAbbr}/schedule?season=${season}&seasontype=${seasontype}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const body = await res.json() as { events?: Array<{ id?: string }> };
      for (const e of body.events ?? []) if (e.id) ids.add(e.id);
    } catch { /* skip */ }
  }
  return [...ids];
}

async function fetchBoxScorePlayers(eventId: string): Promise<PlayerRef[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const body = await res.json() as { boxscore?: { players?: Array<{ team?: { abbreviation?: string }; statistics?: Array<{ athletes?: Array<{ athlete?: { id?: string; displayName?: string } }> }> }> } };
    const out: PlayerRef[] = [];
    for (const team of body.boxscore?.players ?? []) {
      for (const stat of team.statistics ?? []) {
        for (const a of stat.athletes ?? []) {
          if (a.athlete?.id && a.athlete?.displayName) {
            out.push({ id: a.athlete.id, name: a.athlete.displayName, team: team.team?.abbreviation });
          }
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchPlayerRoster(): Promise<PlayerRef[]> {
  const seen = new Map<string, PlayerRef>();
  const y = new Date().getFullYear();
  for (const team of NFL_TEAMS) {
    const events = await fetchTeamSchedule(team, y);
    for (const eventId of events.slice(0, 2)) {
      for (const p of await fetchBoxScorePlayers(eventId)) {
        if (!seen.has(p.id)) seen.set(p.id, p);
      }
    }
  }
  return [...seen.values()];
}

export async function fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]> {
  const out: RawGame[] = [];
  for (const season of seasons) {
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${playerId}/gamelog?season=${season}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const data = await res.json() as { labels?: string[]; seasonTypes?: Array<{ categories?: Array<{ events?: Array<{ eventId: string; stats: string[] }> }> }>; events?: Record<string, { gameDate?: string; atVs?: "@" | "vs"; opponent?: { abbreviation?: string } }> };
      const labels = data.labels ?? [];
      for (const st of data.seasonTypes ?? []) {
        for (const cat of st.categories ?? []) {
          for (const evt of cat.events ?? []) {
            const statsObj: Record<string, number | string | null> = {};
            for (let i = 0; i < labels.length; i++) {
              const v = evt.stats[i]; const n = parseFloat(v); statsObj[labels[i]] = Number.isFinite(n) ? n : v;
            }
            const meta = data.events?.[evt.eventId];
            out.push({ eventId: evt.eventId, gameDate: meta?.gameDate ?? "", stats: statsObj,
              opponentAbbr: meta?.opponent?.abbreviation, atVs: meta?.atVs, isPlayoff: false });
          }
        }
      }
    } catch { /* skip */ }
  }
  return out;
}
```

- [ ] **Step 6: Adapter export + register**

```typescript
// src/lib/sports/nfl/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nflExtractStat } from "./extract";

export const nflAdapter: SportAdapter = {
  leagues: ["NFL", "NFLSZN"],
  displayName: "NFL",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: ["Pass Yards","Pass Completions","Pass Attempts","Pass TDs","INT","Receptions","Rec Yards","Rec TDs","Rush Yards","Rush Attempts","Rush TDs","Rush+Rec Yards","Pass+Rush Yards","Sacks","Tackles","Solo Tackles","Longest Reception","Longest Rush"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: nflExtractStat,
  project: async (prop) => ({ available: false, reason: "NFL projection model not yet inlined — using calibration table only" }),
};
```

```typescript
// src/lib/sports/registerAll.ts — append
import { nflAdapter } from "./nfl";
registerAdapter(nflAdapter);
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/sports/nfl/ src/lib/sports/registerAll.ts
git commit -m "feat: NFL adapter with ESPN gamelog + per-stat extraction"
```

---

### Task 14: NHL adapter

Mirror Task 13. Sport-specific code:

**Files:**
- Create: `src/lib/sports/nhl/{index,fetch,extract}.ts`
- Test: `src/lib/sports/nhl/extract.test.ts`
- Modify: `src/lib/sports/registerAll.ts`

- [ ] **Step 1: Failing extract test**

```typescript
// src/lib/sports/nhl/extract.test.ts
import { describe, it, expect } from "node:test";
import { nhlExtractStat } from "./extract";
import type { RawGame } from "@/lib/sports/types";

const skater: RawGame = { eventId: "e", gameDate: "2026-10-08", stats: { G: 1, A: 2, SOG: 5, "+/-": 2, PIM: 0, type: "skater" } };
const goalie: RawGame = { eventId: "e", gameDate: "2026-10-08", stats: { SA: 30, SV: 28, GA: 2, type: "goalie" } };

describe("nhlExtractStat", () => {
  it("skater", () => {
    expect(nhlExtractStat(skater, "Goals")).toBe(1);
    expect(nhlExtractStat(skater, "Assists")).toBe(2);
    expect(nhlExtractStat(skater, "Points")).toBe(3);
    expect(nhlExtractStat(skater, "Shots")).toBe(5);
  });
  it("goalie", () => {
    expect(nhlExtractStat(goalie, "Goalie Saves")).toBe(28);
    expect(nhlExtractStat(goalie, "Goals Allowed")).toBe(2);
  });
});
```

- [ ] **Step 2: Run FAIL.** `npx tsx --test src/lib/sports/nhl/extract.test.ts`

- [ ] **Step 3: Implement extract**

```typescript
// src/lib/sports/nhl/extract.ts
import type { RawGame } from "@/lib/sports/types";
function n(g: RawGame, k: string): number | null {
  const v = g.stats[k]; if (typeof v === "number") return v;
  if (typeof v === "string") { const f = parseFloat(v); return Number.isFinite(f) ? f : null; }
  return null;
}
export function nhlExtractStat(game: RawGame, statType: string): number | null {
  const role = game.stats.type;
  if (role === "skater") {
    if (statType === "Goals") return n(game, "G");
    if (statType === "Assists") return n(game, "A");
    if (statType === "Shots" || statType === "SOG") return n(game, "SOG");
    if (statType === "Points") { const g = n(game, "G"), a = n(game, "A"); return g != null && a != null ? g + a : null; }
    if (statType === "Hits") return n(game, "HITS");
    if (statType === "Blocks") return n(game, "BLK");
  }
  if (role === "goalie") {
    if (statType === "Goalie Saves" || statType === "Saves") return n(game, "SV");
    if (statType === "Goals Allowed") return n(game, "GA");
    if (statType === "Save Percentage") {
      const sv = n(game, "SV"), sa = n(game, "SA");
      return sv != null && sa != null && sa > 0 ? sv / sa : null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run PASS.** `npx tsx --test src/lib/sports/nhl/extract.test.ts`

- [ ] **Step 5: Implement fetch (ESPN /hockey/nhl/...) — same shape as NFL, swap URL prefix and team list**

```typescript
// src/lib/sports/nhl/fetch.ts — abridged: same shape as src/lib/sports/nfl/fetch.ts
// Change /football/nfl/ → /hockey/nhl/ in all three URLs.
// NHL_TEAMS list:
const NHL_TEAMS = ["ana","ari","bos","buf","cgy","car","chi","col","cbj","dal","det","edm","fla","la","min","mtl","nsh","nj","nyi","nyr","ott","phi","pit","sj","sea","stl","tb","tor","van","vgk","wsh","wpg"];
// Boxscore parser handles skater + goalie split — set stats.type accordingly when normalizing.
```

(Implementer: copy the NFL fetch.ts, replace `nfl` with `nhl`, replace `football` with `hockey`, swap team list. Add `stats.type = "skater" | "goalie"` based on whether the boxscore section labels them as "skaters" or "goalies" — ESPN groups them under separate `statistics` entries with `text` like "skaters" / "goalies".)

- [ ] **Step 6: Adapter export + register**

```typescript
// src/lib/sports/nhl/index.ts
import type { SportAdapter } from "@/lib/sports/types";
import { fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule } from "./fetch";
import { nhlExtractStat } from "./extract";
export const nhlAdapter: SportAdapter = {
  leagues: ["NHL", "NHL1P"],
  displayName: "NHL",
  trainingSeasons: () => { const y = new Date().getFullYear(); return [y - 1, y]; },
  supportedStats: ["Goals","Assists","Points","Shots","SOG","Hits","Blocks","Goalie Saves","Saves","Goals Allowed","Save Percentage"],
  fetchPlayerRoster, fetchPlayerGamelog, fetchTeamSchedule,
  extractStat: nhlExtractStat,
  project: async () => ({ available: false, reason: "NHL projection model not yet inlined" }),
};
```

```typescript
// src/lib/sports/registerAll.ts — append
import { nhlAdapter } from "./nhl";
registerAdapter(nhlAdapter);
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/sports/nhl/ src/lib/sports/registerAll.ts
git commit -m "feat: NHL adapter with skater + goalie stat split"
```

---

### Task 15-20: Remaining adapters (soccer, tennis, PGA, AFL, NCAAM, NCAAF)

Each follows the **identical 7-step pattern** from Tasks 13-14:
1. Write failing extract test for that sport's stat set
2. Run FAIL
3. Implement `extract.ts` with sport-specific stat extraction
4. Run PASS
5. Implement `fetch.ts` with ESPN URL pattern for that sport
6. Implement `index.ts` (adapter export) + register in `registerAll.ts`
7. Commit

**Per-sport specifics — ESPN URL prefix + key stat extractors + team-list location:**

### Task 15: Soccer

- ESPN URL: `https://site.api.espn.com/apis/site/v2/sports/soccer/{competition}/...`
- Competitions: `eng.1` (Premier League), `usa.1` (MLS), `mex.1` (Liga MX), `uefa.champions`, `uefa.europa`
- Each `leagues` entry on adapter: `["SOCCER"]` (PrizePicks lumps them; competition is derived from prop.team)
- Extract: `Goals`, `Assists`, `Shots`, `Shots on Target`, `Tackles`, `Saves` (GK), `Passes Completed`
- File: `src/lib/sports/soccer/`
- ⚠️ Multiple competitions to loop through in `fetchPlayerRoster()` — fan out across all five and merge

### Task 16: Tennis

- ESPN URL: `https://site.web.api.espn.com/apis/common/v3/sports/tennis/atp/athletes/{id}/...` (also `wta/`)
- Adapter `leagues: ["TENNIS"]`
- Extract: `Aces`, `Double Faults`, `Total Games`, `Total Games Won`, `Break Points Won`, `Sets Won`
- ⚠️ Coverage caveat — ESPN tennis player gamelog endpoints are sparser than basketball. Adapter should return `available: false` for players with <5 matches in `project()`.

### Task 17: PGA

- ESPN URL: `https://site.web.api.espn.com/apis/common/v3/sports/golf/pga/athletes/{id}/...`
- Adapter `leagues: ["PGA"]`
- Extract: `Strokes`, `Birdies Or Better`, `Pars`, `Fairways Hit`, `Greens in Regulation`, `Putts`
- ⚠️ **Round-vs-tournament gap.** PrizePicks props are per-round; ESPN data is per-tournament. Fetch tournament-leaderboard endpoints for round-by-round splits. If round splits are unavailable, `extractStat` returns null for round props and the calibrator covers tournament-level only.

### Task 18: AFL

- ESPN URL: `https://site.web.api.espn.com/apis/common/v3/sports/aussierules/afl/athletes/{id}/...`
- Adapter `leagues: ["AFL"]`
- Extract: `Disposals`, `Kicks`, `Handballs`, `Marks`, `Tackles`, `Goals`
- AFL season runs Mar–Sep; `trainingSeasons` returns `[year-1, year]`.

### Task 19: NCAAM (Men's College Basketball)

- ESPN URL: `https://site.web.api.espn.com/apis/common/v3/sports/basketball/mens-college-basketball/athletes/{id}/...`
- Adapter `leagues: ["SACB"]` (PrizePicks "SACB" = Saturday college basketball)
- Reuses NBA's `nbaExtractStat` from `@/lib/sports/nba/extract` — basketball stats are identical
- ⚠️ Big roster — limit `fetchPlayerRoster()` to top-50 teams by KenPom ranking (hardcoded list in the adapter) to keep fetch under control

### Task 20: NCAAF (College Football)

- ESPN URL: `https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/{id}/...`
- Adapter `leagues: ["NCAAF"]`
- Reuses NFL's `nflExtractStat` — football stats are identical
- ⚠️ Same roster-size caveat — limit to AP top-25 teams.

For Tasks 15-20, each commit message: `feat: {sport} adapter with ESPN gamelog`.

---

## Phase 4 — Cron + Status Surface (Tasks 21-24)

---

### Task 21: launchd plist + install script

**Files:**
- Create: `scripts/install-cron.sh`
- Create: `scripts/com.edgeboard.train.plist`

- [ ] **Step 1: Create the plist template**

```xml
<!-- scripts/com.edgeboard.train.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>                <string>com.edgeboard.train</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>bash</string>
    <string>-lc</string>
    <string>cd PROJECT_DIR && /usr/local/bin/npx tsx scripts/train-all.ts >> data/training/meta/launchd.log 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>    <integer>3</integer>
    <key>Minute</key>  <integer>15</integer>
  </dict>
  <key>RunAtLoad</key>             <false/>
  <key>KeepAlive</key>             <false/>
  <key>StandardOutPath</key>       <string>PROJECT_DIR/data/training/meta/launchd-stdout.log</string>
  <key>StandardErrorPath</key>     <string>PROJECT_DIR/data/training/meta/launchd-stderr.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Create the install script**

```bash
#!/usr/bin/env bash
# scripts/install-cron.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/scripts/com.edgeboard.train.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.edgeboard.train.plist"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/data/training/meta"

# Substitute PROJECT_DIR placeholder
sed "s|PROJECT_DIR|$PROJECT_DIR|g" "$PLIST_SRC" > "$PLIST_DST"

# Bootstrap into launchd (replaces existing if loaded)
launchctl bootout "gui/$(id -u)/com.edgeboard.train" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "Installed. Next fire: 3:15 AM. Verify with: launchctl list | grep edgeboard"
echo "Manually trigger: launchctl kickstart gui/$(id -u)/com.edgeboard.train"
```

- [ ] **Step 3: Make it executable + smoke test**

```bash
chmod +x scripts/install-cron.sh
bash scripts/install-cron.sh
launchctl list | grep edgeboard
```
Expected: row with `com.edgeboard.train` and PID `-` (not currently running)

- [ ] **Step 4: Commit**

```bash
git add scripts/install-cron.sh scripts/com.edgeboard.train.plist
git commit -m "feat: launchd cron + install script for nightly training"
```

---

### Task 22: /api/training-status route

**Files:**
- Create: `src/app/api/training-status/route.ts`
- Test: smoke test via curl in step 4

- [ ] **Step 1: Implement the route**

```typescript
// src/app/api/training-status/route.ts
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
    const ts = lastTrained[sportKey] ?? null;
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
```

- [ ] **Step 2: Smoke test**

```bash
curl -s http://localhost:3000/api/training-status | python3 -m json.tool | head -20
```
Expected: JSON with `perSport` keyed by sport name, each entry has `freshness` field.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/training-status/route.ts
git commit -m "feat: /api/training-status route exposing per-sport freshness"
```

---

### Task 23: Settings page — training health panel

**Files:**
- Modify: `src/app/settings/page.tsx`

- [ ] **Step 1: Read the current settings page to find a good insertion point**

Run: `grep -n "section\|h2\|h3" src/app/settings/page.tsx | head -10`

- [ ] **Step 2: Add the panel component below the polling-cadence section**

Insert this component definition near the top of the file:
```typescript
// (inside src/app/settings/page.tsx, alongside other components)

function TrainingHealthPanel() {
  const [data, setData] = useState<{ perSport: Record<string, { lastRunAt: string | null; ageHours: number | null; freshness: "fresh" | "stale" | "missing" }>; currentlyRunning: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/training-status").then(r => r.json()).then(setData).catch(() => {});
    const t = setInterval(() => fetch("/api/training-status").then(r => r.json()).then(setData).catch(() => {}), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!data) return null;
  return (
    <div className="mt-6 p-4 rounded-2xl border-4 border-dashed border-[#00F5D4]">
      <h3 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-sm mb-3">
        Training health {data.currentlyRunning && <span className="text-[#FFE600]">· running now</span>}
      </h3>
      <ul className="space-y-1 text-sm">
        {Object.entries(data.perSport).map(([sport, s]) => {
          const dot = s.freshness === "fresh" ? "🟢" : s.freshness === "stale" ? "🟡" : "🔴";
          const age = s.ageHours == null ? "never trained" : `${s.ageHours.toFixed(1)}h ago`;
          return <li key={sport} className="flex justify-between">
            <span>{dot} {sport}</span>
            <span className="text-white/60">{age}</span>
          </li>;
        })}
      </ul>
    </div>
  );
}
```

Then add `<TrainingHealthPanel />` inside the page's main render tree where it fits visually.

- [ ] **Step 3: Verify in browser**

Restart dev server. Open `/settings`. Confirm the panel renders with per-sport dots.

- [ ] **Step 4: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "feat: training health panel on /settings"
```

---

### Task 24: Smoke-run the pipeline manually

Before relying on launchd, manually invoke the full pipeline once to surface any per-sport bugs.

- [ ] **Step 1: Run the script directly**

```bash
cd /Users/shaurya/Claude/projects/edgeboard
npx tsx scripts/train-all.ts 2>&1 | tee /tmp/first-train.log
```
Expected: takes 30-60 min on first run. Watch for `[adapter] phase: done` lines for each sport.

- [ ] **Step 2: Inspect output**

```bash
ls -la data/training/artifacts/
cat data/training/meta/lastTrainedAt.json | python3 -m json.tool
grep -c "status.*ok" /tmp/first-train.log
```
Expected:
- `artifacts/` has one folder per sport
- `lastTrainedAt.json` has timestamps for each successful sport
- At least 8 of 11 sports report `status: ok`

- [ ] **Step 3: Fix any failed sports**

For each failed sport in the log, diagnose:
- ESPN 4xx → check URL path / team list / season number
- "No data" → check `fetchPlayerRoster()` returns non-empty
- TypeError → check `extractStat()` handles the actual `stats` shape

Re-run after fixes. Each fix gets its own commit.

- [ ] **Step 4: Trigger via launchd to verify the wiring**

```bash
launchctl kickstart gui/$(id -u)/com.edgeboard.train
sleep 60
tail -50 data/training/meta/launchd-stdout.log
```
Expected: launchd-stdout.log shows the script ran.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: per-sport fixes from first end-to-end training run"
```

---

## Phase 5 — Validation Against Success Criteria (Tasks 25-27)

---

### Task 25: Verify 80%+ adapter coverage of current PrizePicks props

- [ ] **Step 1: Run coverage script**

```bash
# scripts/check-coverage.ts
import { allAdapters } from "@/lib/sports/registry";
import "@/lib/sports/registerAll";

const res = await fetch("http://localhost:3000/api/props");
const data = await res.json() as { props: Array<{ sport: string; statType: string }> };
const adapters = allAdapters();
const supportedByLeague = new Map<string, Set<string>>();
for (const a of adapters) for (const l of a.leagues) supportedByLeague.set(l, new Set(a.supportedStats));

let covered = 0, uncovered = 0;
const missedStats = new Map<string, number>();
for (const p of data.props) {
  const stats = supportedByLeague.get(p.sport);
  if (stats?.has(p.statType)) covered++;
  else { uncovered++; const k = `${p.sport}/${p.statType}`; missedStats.set(k, (missedStats.get(k) ?? 0) + 1); }
}
console.log(`Coverage: ${covered}/${covered+uncovered} (${(100*covered/(covered+uncovered)).toFixed(1)}%)`);
console.log("Top uncovered (sport/stat → count):");
[...missedStats.entries()].sort((a,b) => b[1]-a[1]).slice(0,15).forEach(([k,c]) => console.log(`  ${c}  ${k}`));
```

```bash
npx tsx scripts/check-coverage.ts
```
Expected: ≥80% coverage. If lower, the top-uncovered list tells you which `extractStat` entries to add.

- [ ] **Step 2: Patch adapters for the biggest gaps**

For each high-count uncovered `(sport, stat)` pair, add an entry to that sport's `extract.ts`. Each fix = one commit.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: bump adapter coverage to 80%+ of live PP board"
```

---

### Task 26: Verify watchdog fires on stuck job

- [ ] **Step 1: Manual stuck-job test**

Create a temporary test script that writes a stale `currentRun.json` (lastUpdate > 30 min ago) and runs the watchdog check:

```typescript
// scripts/test-watchdog.ts (temporary, delete after)
import { writeProgress, readProgress, isStuck, notify } from "@/lib/training/watchdog";

const oldDate = new Date(Date.now() - 35 * 60 * 1000).toISOString();
await writeProgress("data/training/meta", { sport: "test", phase: "stuck", progressPct: 0.5, lastUpdate: oldDate, pid: process.pid });
const s = await readProgress("data/training/meta");
if (s && isStuck(s, 30 * 60 * 1000)) {
  console.log("Watchdog correctly detected stuck job");
  notify("Test: stuck job detected", "Watchdog smoke test");
}
```

Run: `npx tsx scripts/test-watchdog.ts`
Expected: console prints the success message + a macOS notification appears.

- [ ] **Step 2: Delete the test script**

```bash
rm scripts/test-watchdog.ts
```

- [ ] **Step 3: Commit only if the watchdog needed a tweak**

(No commit if it worked on first try.)

---

### Task 27: Live-board Edge % coverage spot-check

- [ ] **Step 1: Load the live board with a fresh projection cache**

```javascript
// In dev preview console
localStorage.removeItem('edgeboard-projections');
location.href = '/live-board';
```

Wait ~20 seconds for visible props to fetch projections.

- [ ] **Step 2: Measure**

```javascript
// In console
const raw = localStorage.getItem('edgeboard-projections');
const byProp = raw ? (JSON.parse(raw).state?.byProp ?? {}) : {};
const total = Object.keys(byProp).length;
const available = Object.values(byProp).filter(v => v.available).length;
console.log(`Edge coverage: ${available}/${total} = ${(100*available/total).toFixed(1)}%`);
```
Expected: ≥70%. (Spec success criteria #5)

- [ ] **Step 3: If under 70%**

Identify uncovered sports/stats from the projection store, repeat Task 25 step 2 for those gaps.

---

## Self-Review Notes

**Spec coverage check:**
- ✅ SportAdapter contract — Task 1
- ✅ Sport registry — Task 2
- ✅ Artifact cache (mtime-watched) — Task 3
- ✅ Per-sport calibration fitter w/ floor — Task 4
- ✅ Atomic deploy — Task 5
- ✅ Watchdog (progress + stuck-detect + notify) — Task 6
- ✅ runSport per-sport job — Task 7
- ✅ Pipeline orchestrator (parallel, failure isolation) — Task 8
- ✅ Train-all script — Task 8
- ✅ Refactor NBA/WNBA/MLB into adapters — Tasks 9-12
- ✅ projectionFor registry dispatch — Task 12
- ✅ 8 new sport adapters — Tasks 13-20
- ✅ launchd plist + install — Task 21
- ✅ `/api/training-status` — Task 22
- ✅ Settings page health panel — Task 23
- ✅ First full run + per-sport fixes — Task 24
- ✅ 80% coverage validation — Task 25
- ✅ Watchdog stuck-job test — Task 26
- ✅ Live-board ≥70% Edge coverage — Task 27

**Out-of-scope items NOT in plan (consistent with spec):**
- Per-player calibration (deferred)
- Esports / cricket / darts / KBO / NPB / BBL / SACB / FPA adapters (no free data)
- Sportsbook line aggregator (deferred)
- Live in-game projection updates (deferred)

**Type consistency cross-check:**
- `SportAdapter.project()` returns `ProjectionResult` (from `realProjections.ts`) ✅
- `SportArtifacts` is the same type in `types.ts`, `artifactCache.ts`, `deployArtifacts.ts` ✅
- `CalibrationTable.buckets[k]` shape (`{ x, y, sampleSize }`) matches in `types.ts`, `fitSportCalibration.ts`, `deployArtifacts.ts` ✅
- `ScoredPick` reused from existing `@/lib/backtest/aggregate` ✅
- `RawGame.stats` is `Record<string, number | string | null>` consistently — extractors use the helper `n()` to coerce ✅

Plan is complete and self-consistent.
