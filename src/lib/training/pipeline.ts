import { writeFile, mkdir, readFile } from "node:fs/promises";
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
  /**
   * Optional allow-list of sport keys (matched against each adapter's
   * leagues[0], case-insensitive). When set, only those sports are trained —
   * used to retry a small subset (e.g. a flaky data source) without redoing
   * the sports that already produced good artifacts.
   */
  sports?: string[];
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
  const filter = opts.sports?.map((s) => s.toLowerCase());
  const adapters = filter
    ? allAdapters().filter((a) => filter.includes(a.leagues[0].toLowerCase()))
    : allAdapters();
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

  // Persist last-trained timestamps (keyed by sport for /api/training-status)
  const metaDir = join(opts.rootDir, "meta");
  await mkdir(metaDir, { recursive: true });
  await writeFile(join(metaDir, "lastTrainedAt.json"), JSON.stringify(
    Object.fromEntries(results.filter(r => r.status === "ok").map(r => [r.sport, summary.finishedAt])),
    null, 2,
  ));

  // Append a run-history entry recording the champion-challenger decision per
  // sport (improved / refreshed / held / deployed-first). This is the record
  // that makes "is the model actually getting better day over day" answerable
  // from data instead of asserted in copy. Kept bounded to the last 365 runs.
  const historyPath = join(metaDir, "runHistory.json");
  let history: unknown[] = [];
  try {
    const parsed = JSON.parse(await readFile(historyPath, "utf8"));
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    history = [];
  }
  history.push({
    finishedAt: summary.finishedAt,
    okCount,
    failedCount,
    sports: results.map((r) => ({
      sport: r.sport,
      status: r.status,
      decision: r.decision ?? null,
      testLogLoss: r.testMetrics?.logLoss ?? null,
      championLogLoss: r.championLogLoss ?? null,
      accuracy: r.testMetrics?.accuracy ?? null,
      lift: r.testMetrics ? r.testMetrics.baselineLogLoss - r.testMetrics.logLoss : null,
    })),
  });
  await writeFile(historyPath, JSON.stringify(history.slice(-365), null, 2));

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
