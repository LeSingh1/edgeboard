import { registerAdapter } from "./registry";
import { nbaAdapter } from "./nba";
registerAdapter(nbaAdapter);
import { wnbaAdapter } from "./wnba";
registerAdapter(wnbaAdapter);
import { mlbAdapter } from "./mlb";
registerAdapter(mlbAdapter);
