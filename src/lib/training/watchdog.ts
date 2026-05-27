import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface ProgressState {
  sport: string;
  phase: string;            // "roster" | "fetch" | "score" | "calibrate" | "deploy" | "done"
  progressPct: number;      // 0..1
  lastUpdate: string;       // ISO
  pid: number;
}

const META_FILE = "currentRun.json";

export async function writeProgress(metaDir: string, state: ProgressState): Promise<void> {
  await mkdir(metaDir, { recursive: true });
  await writeFile(join(metaDir, META_FILE), JSON.stringify(state, null, 2));
}

export async function readProgress(metaDir: string): Promise<ProgressState | null> {
  try {
    const txt = await readFile(join(metaDir, META_FILE), "utf8");
    return JSON.parse(txt) as ProgressState;
  } catch { return null; }
}

export function isStuck(state: ProgressState, thresholdMs: number): boolean {
  const age = Date.now() - new Date(state.lastUpdate).getTime();
  return age > thresholdMs;
}

/**
 * Fire a macOS notification via osascript. Silently no-ops on non-Darwin.
 * Title is fixed to "EdgeBoard"; subtitle/message are caller-controlled.
 */
export function notify(message: string, subtitle?: string): void {
  if (process.platform !== "darwin") return;
  const escaped = message.replace(/"/g, '\\"');
  const sub = subtitle ? `subtitle "${subtitle.replace(/"/g, '\\"')}"` : "";
  const script = `display notification "${escaped}" ${sub} with title "EdgeBoard"`;
  const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
  child.unref();
}
