#!/usr/bin/env tsx
// Temporary: retrain only the cap-boosted sports to verify sample-size gains.
import { runSport } from "@/lib/training/runSport";
import { getAdapterFor } from "@/lib/sports/registry";
import "@/lib/sports/registerAll";

const LEAGUES = ["SOCCER", "NFL", "NCAAF", "AFL"];

async function main() {
  for (const league of LEAGUES) {
    const adapter = getAdapterFor(league);
    if (!adapter) { console.log(`${league}: no adapter`); continue; }
    const t0 = Date.now();
    const r = await runSport(adapter, { rootDir: "data/training", minBucketSize: 500 });
    console.log(`${league}: status=${r.status} samples=${r.sampleSize} (${((Date.now() - t0) / 1000).toFixed(0)}s)${r.error ? " err=" + r.error : ""}`);
  }
}
main();
