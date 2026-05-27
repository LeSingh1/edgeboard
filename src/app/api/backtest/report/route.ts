import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Returns the latest backtest report from disk, or a 404-shaped empty
 * payload if it hasn't been generated yet. The Model Lab panel reads
 * this on mount.
 *
 * The backtest itself runs out-of-band via `npx tsx scripts/backtest.ts`
 * — no run-from-browser endpoint by design (see spec: keeps the
 * pipeline iterable from the terminal without spinning the dev server).
 */

const DATA_DIR = path.join(process.cwd(), "data", "backtest");
const REPORT_PATH = path.join(DATA_DIR, "report.json");
const CALIBRATION_PATH = path.join(DATA_DIR, "calibration.json");
const CV_PATH = path.join(DATA_DIR, "crossValidation.json");
const WALKFWD_PATH = path.join(DATA_DIR, "walkForward.json");

export async function GET() {
  try {
    const [reportRaw, calibrationRaw, cvRaw, walkRaw] = await Promise.all([
      fs.readFile(REPORT_PATH, "utf8").catch(() => null),
      fs.readFile(CALIBRATION_PATH, "utf8").catch(() => null),
      fs.readFile(CV_PATH, "utf8").catch(() => null),
      fs.readFile(WALKFWD_PATH, "utf8").catch(() => null),
    ]);
    if (!reportRaw) {
      return NextResponse.json(
        { available: false, reason: "Backtest hasn't been run yet. Try: npx tsx scripts/backtest.ts" },
        { status: 200 },
      );
    }
    return NextResponse.json({
      available: true,
      report: JSON.parse(reportRaw),
      calibration: calibrationRaw ? JSON.parse(calibrationRaw) : null,
      crossValidation: cvRaw ? JSON.parse(cvRaw) : null,
      walkForward: walkRaw ? JSON.parse(walkRaw) : null,
    });
  } catch (err) {
    return NextResponse.json(
      { available: false, reason: String(err) },
      { status: 200 },
    );
  }
}
