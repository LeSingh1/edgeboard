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
