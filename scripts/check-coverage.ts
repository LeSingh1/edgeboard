#!/usr/bin/env tsx
import { allAdapters } from "@/lib/sports/registry";
import "@/lib/sports/registerAll";

async function main() {
  const res = await fetch("http://localhost:3000/api/props");
  if (!res.ok) {
    console.error(`Could not reach /api/props — is the dev server running? HTTP ${res.status}`);
    process.exit(2);
  }
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
  const total = covered + uncovered;
  const pct = total ? (100 * covered) / total : 0;
  console.log(`Coverage: ${covered}/${total} (${pct.toFixed(1)}%)`);
  console.log("\nTop uncovered (sport/stat → count):");
  [...missedStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, c]) => console.log(`  ${c.toString().padStart(4)}  ${k}`));
  process.exit(pct >= 80 ? 0 : 1);
}
main();
