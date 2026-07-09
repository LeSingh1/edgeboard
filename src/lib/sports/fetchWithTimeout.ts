// A fetch() with a hard timeout. A training crawl makes thousands of sequential
// upstream calls; without a timeout, ONE stalled connection hangs the whole daily
// cycle forever (observed 2026-06: an MLB statsapi fetch froze the run for 11 days
// while holding the training lock, so nothing retrained and every model went
// stale). AbortSignal.timeout aborts the request after `ms`, turning an infinite
// hang into a normal error the caller's try/catch skips over.
export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  ms = 20_000,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
