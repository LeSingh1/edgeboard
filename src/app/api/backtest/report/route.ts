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

const REPORT_PATH = path.join(process.cwd(), "data", "backtest", "report.json");
const CALIBRATION_PATH = path.join(process.cwd(), "data", "backtest", "calibration.json");

export async function GET() {
  try {
    const [reportRaw, calibrationRaw] = await Promise.all([
      fs.readFile(REPORT_PATH, "utf8").catch(() => null),
      fs.readFile(CALIBRATION_PATH, "utf8").catch(() => null),
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
    });
  } catch (err) {
    return NextResponse.json(
      { available: false, reason: String(err) },
      { status: 200 },
    );
  }
}
