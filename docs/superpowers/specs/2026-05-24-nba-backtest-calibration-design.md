# NBA Backtest + Isotonic Calibration

**Date:** 2026-05-24
**Author:** Shaurya
**Status:** Design approved, ready for implementation
**Budget:** ~2 hours

## Goal

Backtest the EdgeBoard heuristic projection model against the 2025-26 NBA season's actual game results, produce a calibration report, and fit an isotonic regression that corrects systematic mis-prediction. The corrected model becomes an opt-in setting; the report lives in Model Lab.

## Non-goals

- **Not testing edge vs PrizePicks.** Without historical PP lines (which don't exist), we can't measure whether the model beats their lines. We test **calibration** instead — does the model's stated probability match reality?
- **Not a full ML classifier.** Logistic regression on per-pick features (recent form, vs-opp, days rest, etc.) would tell us which features matter most, but it's a Phase 2 build. This phase trains a 1-D corrector only.
- **Not a slip-level backtest.** We score individual picks, not constructed lineups. Lineup-level dynamics (correlation, payouts) are derivable from per-pick calibration plus the existing optimizer logic.

## Constraint that shapes everything

PrizePicks doesn't publish historical lines. We synthesize lines from the player's own rolling gamelog (standard at the rolling median, goblin at median − 0.5σ, demon at median + 0.5σ). The lines are honest stand-ins, not real PP lines. This means:

- We measure **whether the model's pMore matches the actual hit rate** on lines drawn from the same distribution we model. That's calibration.
- We do NOT measure **whether the model beats PP's actual market.** That requires real historical lines and is a future project.

The calibration output is still highly valuable: it tells you *"when the model says 70%, it actually hits X%"* and produces a learned corrector that closes the gap.

## Architecture

Standalone TypeScript script runs end-to-end, dumps JSON artifacts to `data/backtest/`. Model Lab reads the JSON via a small server route and renders the report. No long-running HTTP requests, no in-app progress UI, easy to iterate from the terminal.

```
scripts/backtest.ts (entry point)
  │
  ├─► src/lib/backtest/fetchSeasonLogs.ts
  │     ESPN → data/backtest/gamelogs.json (gitignored, idempotent)
  │
  ├─► src/lib/backtest/synthesizeLines.ts
  │     pure: gamelog → { player, date, stat, line, oddsType }[]
  │     no look-ahead — only games before target date
  │
  ├─► src/lib/backtest/scoreModel.ts
  │     pure: (gamelog-up-to-date, line, statType, oddsType) → pMore
  │     extracted from realProjections.ts; same math as live
  │
  ├─► src/lib/backtest/aggregate.ts
  │     buckets predicted pMore by 10-pt bins, computes hit rates,
  │     residuals, per-oddsType breakouts, synthetic P/L
  │     → data/backtest/report.json
  │
  └─► src/lib/backtest/fitCalibration.ts
        pool-adjacent-violators isotonic regression
        → data/backtest/calibration.json

Live-side integration (opt-in):
  src/lib/applyCalibration.ts   loads calibration.json at startup
  src/lib/realProjections.ts    calls calibrate() at end of pipeline
                                if settings.calibrationEnabled === true
  src/components/BacktestReport.tsx  renders report.json in Model Lab
```

## Components

### `fetchSeasonLogs.ts`
- **Input:** none (whole 2025-26 NBA season, all 30 teams)
- **Output:** `data/backtest/gamelogs.json` — `Record<playerName, GameLogEntry[]>`
- **Behavior:** uses existing ESPN gamelog helpers (`espnFindAthleteId`, `espnGameLog`). Concurrency: batches of 8, ~3-5s sleep between batches to respect rate limits. Skips fetch if cache file exists and is <24h old. Per-player try/catch — partial datasets are fine.
- **Why ESPN, not BallDontLie:** existing code uses ESPN, no API key required, deeper history.

### `synthesizeLines.ts`
- **Input:** gamelogs + target stat (PTS, REB, AST, 3PM, STL+BLK, PRA, PR, PA)
- **Output:** `BacktestRow[]` — `{ player, date, stat, standardLine, goblinLine, demonLine, actualValue }`
- **Behavior:** for each game N, computes rolling μ and σ from games [0..N-1]. Requires ≥8 prior games; skips otherwise. Lines:
  - `standardLine = roundToHalf(μ)` — line at median, 50/50 baseline
  - `goblinLine = roundToHalf(μ - 0.5σ)` — easier, MORE more likely
  - `demonLine = roundToHalf(μ + 0.5σ)` — harder, MORE less likely
- `roundToHalf(x)` rounds to nearest .5 to match PP convention (no whole-number lines).

### `scoreModel.ts`
- **Input:** `(gamelogUpToDate, line, statType, oddsType)`
- **Output:** `{ pMore, pLess, adjustments }` — same shape as live `RealProjection`
- **Behavior:** lifts the math from `realProjections.ts:buildResult` + `applyAdjustments` into a parameterized form that doesn't fetch. Same sigma floor (`max(std, mean × 0.15, 0.5)`), same normal CDF, same clamps (`[0.02, 0.98]`), same four adjustment signals (recent form, vs-opp, home/away, days rest). Reuses the chronoValues/opponents/atVs/dates arrays from the gamelog.
- **Why a separate file:** the live `realProjections.ts` is structured around fetching. We need a pure variant that operates on pre-fetched data with an explicit date cutoff. The functional core stays identical so the backtest tests the *real* model.

### `aggregate.ts`
- **Input:** `Array<{ predictedPMore, side, actualValue, line, oddsType, stat }>`
- **Output:** `data/backtest/report.json`
- **Schema:**
  ```ts
  {
    generatedAt: string;
    totalPicks: number;
    samplesPerBucket: { range: string, predicted: number, actual: number, n: number, residual: number }[];
    byOddsType: { standard: Bucket[], goblin: Bucket[], demon: Bucket[] };
    syntheticPL: { totalPicks, hits, hitRate, ev_per_pick, ev_total };
    perStat: Record<string, { n, hitRate, residual }>;
  }
  ```
- **Behavior:** for each row, computes `hit = side === "more" ? actualValue > line : actualValue < line`. The chosen side is whichever has the higher predicted prob (i.e. we bet the model's preference). Buckets predicted prob by 10-pt bins from 0.5 to 1.0. Per-oddsType breakouts since demons/goblins are typically miscalibrated differently than standards.

### `fitCalibration.ts`
- **Input:** array of `(predicted, hit ∈ {0,1})` pairs
- **Output:** `data/backtest/calibration.json` — `{ breakpoints: Array<{predicted, corrected}> }`
- **Algorithm:** pool-adjacent-violators (PAVA) — sort by predicted, walk through and merge adjacent violator blocks where the running mean of `hit` is decreasing. Result is a monotonically non-decreasing step function. ~30 lines, no library.
- **Apply:** linear interpolation between adjacent breakpoints. Extrapolate flat at the endpoints. Monotonicity asserted post-fit.

### `applyCalibration.ts` (live integration)
- **Input:** `(pMoreRaw: number)` — output of existing pipeline
- **Output:** corrected pMore
- **Behavior:** lazy-loads `calibration.json` at module init (server-side, cached in memory). Linear interp between breakpoints. Returns `pMoreRaw` unchanged if the file doesn't exist yet (graceful fallback when backtest hasn't been run).
- **Wiring:** called at the end of `realProjections.ts` only when `settings.calibrationEnabled === true`. Default off.

### `BacktestReport.tsx` (Model Lab UI)
- Renders `report.json` via a small server route `GET /api/backtest/report` that reads from disk.
- Sections:
  - Header: total picks, date range, last run, "re-run via `npx tsx scripts/backtest.ts`" callout
  - **Calibration table**: bucket | predicted% | actual% | residual | n. Color-coded by |residual| (green <2%, yellow 2-5%, red >5%).
  - **Per-oddsType breakout**: 3 compact tables side-by-side.
  - **Synthetic P/L summary**: total picks, hits, hit rate, EV per pick (using current FLEX_PAYOUT_TABLES min guarantees), EV total at $10/pick.
  - **Calibration enable toggle** (in Settings, surfaced here as a link).

## Data flow

Single pass through the gamelogs. No fan-out:
```
ESPN ──► gamelogs.json ──► synthesizeLines() ──► rows[]
                                   │                │
                                   ▼                ▼
                         gamelog-up-to-N ──► scoreModel() ──► pMore + side
                                                                │
                                                actual game N ──► hit
                                                                │
                                                                ▼
                                                  aggregate() ──► report.json
                                                                │
                                                                ▼
                                                fitCalibration() ──► calibration.json
```

## Error handling

| Failure | Strategy |
|---|---|
| ESPN 5xx / network error during fetch | Per-player try/catch, log + skip. Partial dataset is fine for calibration. |
| Player has <8 prior games at target date | Skip that row. Cold-start, same threshold as live `buildResult`. |
| `scoreModel` returns NaN/Infinity | Clamp to 0.5, log warning. Should not happen with sigma floor but defensive. |
| Calibration curve not monotonic | PAVA guarantees this. Asserted post-fit; crash if violated. |
| Apply-calibration sees pMore outside training range | Extrapolate flat (nearest endpoint). |
| `calibration.json` doesn't exist yet at startup | `applyCalibration` returns input unchanged. Live model is unaffected. |

## Testing

Minimal — 2-hour build:

1. **Smoke test on one player.** Hardcode "LeBron James" or similar; run the full pipeline. Assert: report has ≥50 picks, high-prob bucket hit rate > low-prob bucket hit rate.
2. **Calibration round-trip.** Run model on the training data with calibration applied. Bucket residuals should shrink. If they don't, fit is broken.
3. **No-look-ahead assertion.** In `scoreModel`, assert the gamelog passed in contains no games on or after the target date.

No unit tests for individual components — would eat 30 min that's better spent on analysis.

## File layout

```
scripts/
  backtest.ts                            (new, entry point)
src/lib/backtest/
  fetchSeasonLogs.ts                     (new)
  synthesizeLines.ts                     (new)
  scoreModel.ts                          (new — refactored from realProjections)
  aggregate.ts                           (new)
  fitCalibration.ts                      (new)
src/lib/
  applyCalibration.ts                    (new, live-side)
  realProjections.ts                     (modified — optionally calls applyCalibration)
src/app/api/backtest/report/
  route.ts                               (new, GET only)
src/components/
  BacktestReport.tsx                     (new, Model Lab panel)
src/app/model-lab/page.tsx               (modified — mounts BacktestReport)
src/stores/settingsStore.ts              (modified — calibrationEnabled flag)
data/backtest/
  gamelogs.json                          (generated, gitignored)
  report.json                            (generated, gitignored)
  calibration.json                       (generated, gitignored)
.gitignore                               (modified — add data/backtest/)
```

## Run procedure (for the user, after build)

```bash
# 1. Run the backtest (5-10 min wall time, mostly ESPN fetches)
npx tsx scripts/backtest.ts

# 2. Open Model Lab in the browser, scroll to Backtest Report.

# 3. If the calibration looks useful, flip the Settings toggle to
#    enable it. Live model now applies the corrector to every pMore.

# 4. Re-run the backtest anytime by repeating step 1.
```

## What this does NOT solve (explicit Phase 2 items)

- Real PP-line edge testing — needs historical lines
- Feature-level model training — logistic regression on per-pick features
- Slip-level backtest — building full lineups and scoring against actual results
- Live retraining — calibration today is a manual `tsx scripts/backtest.ts` re-run

These are intentionally out of scope to fit the 2-hour budget.
