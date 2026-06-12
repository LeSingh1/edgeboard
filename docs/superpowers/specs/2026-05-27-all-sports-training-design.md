# All-Sports Training Pipeline — Design

**Date:** 2026-05-27
**Status:** Approved, ready for implementation plan
**Author:** brainstorming session with Shaurya

## Problem

Edgeboard's projection model only covers NBA, WNBA, and MLB today. PrizePicks ships props in 27 leagues — the other 24 fall back to "PrizePicks-implied probability" which is a 50/40/59% guess, not a real model output. The user wants every sport in scope to be properly trained with real per-(sport, stat) calibration, refreshed nightly, with watchdog monitoring.

## Scope

**In:** Sports that ESPN + Kalshi cover for free AND appear on PrizePicks:

- NBA, WNBA, MLB (existing — refactored into the new adapter shape)
- NFL, NHL (new — ESPN public API has gamelogs)
- Soccer — EPL, MLS, Liga MX, UEFA competitions (new)
- Tennis — ATP + WTA (new, coverage caveats — see Risks)
- PGA (new)
- AFL (new)
- NCAAM, NCAAF (new)

Segment leagues (NBA1Q, NBA1H, WNBA1Q, WNBA1H, NHL1P, MLBLIVE) are sub-models of their parent sport — same gamelogs, scaled stats. Handled within each adapter.

**Out:** Esports (CS2, LoL, VAL, COD), cricket, darts, KBO, NPB, BBL, SACB, FPA. No reliable free data through ESPN/Kalshi for these.

## Constraints

| Decision | Locked in |
|---|---|
| Retrain cadence | Nightly @ 3:15 AM local via macOS launchd |
| Runtime | Local on user's Mac (queued for next wake if asleep at fire time) |
| Architecture | Per-sport adapters with shared training core (Approach B) |
| Calibration granularity | Per-(sport, stat, oddsType). NOT per-player. |
| Kalshi role | Inference-time blend only. NOT used as a training signal. |
| Cost | $0 — all free public APIs |
| Watchdog | Required: 30-min stuck-job detector + macOS notifications + `/api/training-status` |

## Architecture

```
src/lib/sports/{nba,wnba,mlb,nfl,nhl,soccer,tennis,pga,afl,ncaam,ncaaf}/
                                  │ implements SportAdapter
                                  ▼
src/lib/training/                    src/lib/realProjections.ts
  pipeline.ts (orchestrator)         dispatches via sport registry to adapter
  runSport.ts (per-sport job)        reads artifacts via lazy mtime-watched cache
  incrementalFetch.ts                blends with Kalshi at the end
  trainingCore.ts (shared algo)
  deployArtifacts.ts (atomic swap)
  watchdog.ts (stuck-job detect)
                                  │ reads/writes
                                  ▼
data/training/
  gamelogs/{sport}.json              cumulative corpus, gitignored
  artifacts/{sport}/                 calibration, defense, breakout, gameScript
  meta/                              lastTrainedAt, runHistory, currentRun
```

Triggered nightly by `~/Library/LaunchAgents/com.edgeboard.train.plist` → `scripts/train-all.ts`.

### SportAdapter contract

```typescript
interface SportAdapter {
  readonly leagues: string[];           // e.g. ["NBA", "NBA1Q", "NBA1H"]
  readonly displayName: string;
  readonly trainingSeasons: () => number[];
  readonly supportedStats: string[];

  fetchPlayerRoster(): Promise<PlayerRef[]>;
  fetchPlayerGamelog(playerId: string, seasons: number[]): Promise<RawGame[]>;
  fetchTeamSchedule(teamAbbr: string, season: number): Promise<string[]>;
  extractStat(game: RawGame, statType: string): number | null;
  project(prop: Prop, artifacts: SportArtifacts): Promise<ProjectionResult>;

  // Optional adjustments — adapter declares only what makes sense
  recentFormAdjustment?(values: number[]): Adjustment | null;
  vsOpponentAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  homeAwayAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  daysRestAdjustment?(prop: Prop, gamelog: RawGame[]): Adjustment | null;
  defenseAdjustment?(prop: Prop, ratings: DefenseRatings): Adjustment | null;
}
```

Optional adjustments are opt-in functions. NBA implements all five; PGA implements only recentForm (golf has no opponent matchup). Adapter declares its own scope.

### Training pipeline

Per-sport job (`runSport.ts`):

1. **Incremental fetch** — append new games newer than corpus.lastIngestedAt
2. **Extract stat values** — corpus → `{ stat: number[] }` per player
3. **Build defense ratings** (if `adapter.defenseAdjustment` declared)
4. **Build breakout profiles** (if applicable)
5. **Synthesize lines + score model + fit calibration** — per (stat, oddsType)
6. **Write artifacts** → `data/training/artifacts/{sport}.tmp/` → atomic rename

Orchestrator (`pipeline.ts`) fans out jobs in parallel with a cap of 4 concurrent sports (to stay under ESPN's ~10 req/sec rate limit). Each sport's failure is isolated — NFL failing doesn't kill NHL.

### Atomic artifact deploy

Write to `data/training/artifacts/{sport}.tmp/` → `fsync` each file → `rename()` `.tmp` to live path. POSIX rename within the same filesystem is atomic; readers see old-or-new, never partial.

Live model uses a lazy in-memory cache keyed by file `mtime`. New artifacts get picked up on the next request without app restart.

### Watchdog (3 layers)

1. **Progress checkpoint** — every per-sport job writes `data/training/meta/currentRun.json` with `{ sport, phase, progressPct, lastUpdate, pid }` on every phase change.

2. **Stuck-job detector** — in-process `setInterval(checkStuck, 30 min)`. If `currentRun.lastUpdate` is >30 min stale, log the stuck phase, dump active sport's state, send a macOS notification via `osascript`, kill that sport's worker (others keep going).

3. **Post-run summary** — orchestrator exit fires one notification:
   - `✅ EdgeBoard trained — N sports, M min`
   - `⚠️ EdgeBoard partial — N ok, X failed`
   - `❌ EdgeBoard FAILED`

`/api/training-status` exposes `{ lastRunAt, currentlyRunning, perSportStatus }` — surfaced as a "Training health" panel in `/settings` with green/yellow/red dots per sport.

## Data layout

```
data/training/
├── gamelogs/                  # Cumulative corpus, gitignored
│   ├── nba.json      ~120 MB
│   ├── wnba.json     ~25 MB
│   ├── mlb.json      ~280 MB
│   ├── nfl.json      ~45 MB
│   ├── nhl.json      ~60 MB
│   ├── soccer.json   ~80 MB
│   ├── tennis.json   ~15 MB
│   ├── pga.json      ~8 MB
│   ├── afl.json      ~5 MB
│   ├── ncaam.json    ~200 MB
│   └── ncaaf.json    ~30 MB
├── artifacts/{sport}/
│   ├── calibration.json
│   ├── defenseRatings.json
│   ├── breakoutProfiles.json
│   ├── gameScriptProfile.json
│   └── metadata.json
└── meta/
    ├── lastTrainedAt.json
    ├── runHistory.json
    └── currentRun.json
```

Total disk footprint: ~870 MB after first full run. Gitignored.

## Sample size floor

Each `(sport, stat, oddsType)` bucket needs ≥500 scored picks to fit a calibrator. Below floor → skip calibration for that bucket, use raw model output. Better than mis-calibrating on noise.

## Risks

1. **ESPN rate limiting at scale** — biggest hit is NCAAM (350 teams). Mitigation: incremental fetch + 4-sport parallel cap.
2. **Tennis player coverage gaps** — ESPN's tennis gamelog is shakier than basketball. Mitigation: `available: false` for players with <5 matches.
3. **Per-sport stat-type quirks** — combined stats (Hits+Runs+RBIs, Pts+Rebs) need declarative recipes per adapter.
4. **PGA round-based vs game-based** — may need a different fetch path. Mitigation: prototype PGA early; if it doesn't fit the adapter shape, ship without calibration and use raw projection.
5. **First full training run is 30-60 min, ~2 GB pulled** — orchestrator checkpoints per-sport corpus to disk during fetch, so a crash mid-run resumes on the next attempt.
6. **Calibrators on small samples** — sample size floor (#1 above) mitigates.
7. **Long-tail sports may not pay back the dev cost** — tennis + AFL + PGA + NCAA combined are ~10% of PrizePicks volume but ~50% of dev work. User accepted this knowingly.

## Open questions (resolved defaults)

| Question | Default |
|---|---|
| Per-player vs per-(sport, stat) calibration | Per-(sport, stat). Per-player needs ≥50 picks/player which most don't have. |
| Kalshi prices as training signal vs inference blend | Inference blend only (today's behavior). Avoid leaning on illiquid quotes. |
| Cache live ESPN gamelogs server-side beyond Next.js | No. Next.js per-request cache + nightly incremental is enough. |
| Stuck-job threshold for watchdog | 30 min with no phase-change update. |
| `/api/training-status` auth | Public read. No secrets in artifacts. |

## Time estimate

~22 hours of focused development work. First full training run: 30-60 min wall clock. Subsequent nightly runs: ~10-15 min incremental.

## Out of scope for v1 (deferred to future work)

- Per-player calibration (needs more data than v1 will have)
- Esports adapters (no reliable free data)
- Cricket, darts, KBO, NPB, BBL, SACB, FPA adapters (same)
- Sportsbook line aggregator (DraftKings/FanDuel via OddsAPI) as a third blending signal
- Live in-game projection updates (MLBLIVE props mid-game)

## Success criteria

1. Every supported league has an adapter that produces `{ available: true }` for at least 80% of its current PrizePicks props.
2. Nightly run completes in <20 min and produces non-empty artifacts for every adapter.
3. `/api/training-status` shows last-run timestamp <36h old for every sport during in-season periods.
4. Watchdog correctly fires a macOS notification when a sport's job stalls >30 min in test conditions.
5. A user-visible Edge percentage appears on >70% of PrizePicks props on the live board (today: ~25% — basketball + baseball only).
