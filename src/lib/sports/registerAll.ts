import { registerAdapter } from "./registry";
import { nbaAdapter } from "./nba";
registerAdapter(nbaAdapter);
import { wnbaAdapter } from "./wnba";
registerAdapter(wnbaAdapter);
import { mlbAdapter } from "./mlb";
registerAdapter(mlbAdapter);
import { nflAdapter } from "./nfl";
registerAdapter(nflAdapter);
import { nhlAdapter } from "./nhl";
registerAdapter(nhlAdapter);
import { soccerAdapter } from "./soccer";
registerAdapter(soccerAdapter);
import { tennisAdapter } from "./tennis";
registerAdapter(tennisAdapter);
import { pgaAdapter } from "./pga";
registerAdapter(pgaAdapter);
import { aflAdapter } from "./afl";
registerAdapter(aflAdapter);
import { ncaamAdapter } from "./ncaam";
registerAdapter(ncaamAdapter);
import { ncaafAdapter } from "./ncaaf";
registerAdapter(ncaafAdapter);
import { lolAdapter } from "./lol";
registerAdapter(lolAdapter);
// NPB intentionally dropped (2026-06-10). npb.jp's box-score scrape throttles
// the ~4000-request fetch, so training failed every run and the model check
// flagged it STALE. We don't use NPB picks, so it's no longer registered — the
// live projection path falls back to "no real model" gracefully, and the
// trainer / watchdog / model-check skip it entirely. Re-add the two lines below
// to bring it back; the adapter code under ./npb is kept for that.
// import { npbAdapter } from "./npb";
// registerAdapter(npbAdapter);
