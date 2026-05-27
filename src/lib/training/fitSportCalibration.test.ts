import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitSportCalibration } from "./fitSportCalibration";
import type { ScoredPick } from "@/lib/backtest/aggregate";
import type { ScoreOutput } from "@/lib/backtest/scoreModel";

// Minimal ScoreOutput stand-in — the calibration fitter only reads
// predictedPMore/hit/stat/oddsType, but ScoredPick demands the field.
const STUB_SCORE = {} as ScoreOutput;

function makePick(over: Partial<ScoredPick>): ScoredPick {
  return {
    side: "more",
    predictedPMore: 0.6,
    hit: false,
    oddsType: "standard",
    stat: "Points",
    score: STUB_SCORE,
    line: 20,
    actualValue: 21,
    ...over,
  };
}

describe("fitSportCalibration", () => {
  it("returns a CalibrationTable bucketed by stat|oddsType", () => {
    // 600 picks spread across 10 predicted-prob levels; ~50% hit rate
    // so PAVA has something to actually fit (not a degenerate flat curve).
    const picks: ScoredPick[] = Array.from({ length: 600 }, (_, i) =>
      makePick({
        stat: "Points",
        oddsType: "standard",
        predictedPMore: 0.5 + (i % 10) * 0.04,
        hit: i % 10 > 4,
      }),
    );
    const result = fitSportCalibration(picks, { minBucketSize: 500 });
    assert.ok(result.buckets["Points|standard"], "Points|standard bucket present");
    assert.equal(result.buckets["Points|standard"].sampleSize, 600);
    assert.ok(result.buckets["Points|standard"].x.length > 0, "x has breakpoints");
    assert.equal(
      result.buckets["Points|standard"].x.length,
      result.buckets["Points|standard"].y.length,
      "x and y aligned",
    );
  });

  it("skips buckets below sample-size floor", () => {
    const picks: ScoredPick[] = Array.from({ length: 100 }, () =>
      makePick({ stat: "Rebounds", oddsType: "standard", predictedPMore: 0.6, hit: true }),
    );
    const result = fitSportCalibration(picks, { minBucketSize: 500 });
    assert.equal(result.buckets["Rebounds|standard"], undefined);
  });
});
