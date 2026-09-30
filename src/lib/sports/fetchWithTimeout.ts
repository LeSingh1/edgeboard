// A fetch() with a hard timeout. A training crawl makes thousands of sequential
// upstream calls; without a timeout, ONE stalled connection hangs the whole daily
// cycle forever (observed 2026-06: an MLB statsapi fetch froze the run for 11 days
// while holding the training lock, so nothing retrained and every model went
// stale). AbortSignal.timeout aborts the request after `ms`, turning an infinite
// hang into a normal error the caller's try/catch skips over.
//
// EDGEBOARD_FETCH_UA: when set, replaces a browser-style ("Mozilla/…") or
// missing User-Agent. ESPN's site.api.espn.com answers 403 to a spoofed
// desktop-Chrome UA coming from a datacenter IP (GitHub Actions) but 200 to an
// honest client UA, so the cloud retrain sets this; on the Mac it's unset and
// nothing changes. Callers that already send an honest UA (e.g. the Leaguepedia
// client, whose API policy asks for contact info) keep their own.
export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  ms = 20_000,
): Promise<Response> {
  const ua = process.env.EDGEBOARD_FETCH_UA;
  let next = init;
  if (ua) {
    const headers = new Headers(init?.headers);
    const current = headers.get("User-Agent");
    if (!current || current.startsWith("Mozilla/")) {
      headers.set("User-Agent", ua);
      next = { ...init, headers };
    }
  }
  return fetch(url, { ...next, signal: AbortSignal.timeout(ms) });
}
