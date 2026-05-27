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
