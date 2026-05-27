import { mkdir, writeFile, rename, rm, open } from "node:fs/promises";
import { join } from "node:path";
import type { SportArtifacts } from "@/lib/sports/types";

interface DeployOpts {
  sport: string;
  rootDir: string;
  artifacts: SportArtifacts;
}

async function writeAndFsync(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2));
  // Open the file and force the OS to flush its buffer to disk. Without this,
  // a crash between writeFile() and rename() could leave the swap pointing at
  // unflushed pages — readers would see an empty file.
  const fd = await open(path, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}

export async function deploySportArtifacts(opts: DeployOpts): Promise<void> {
  const { sport, rootDir, artifacts } = opts;
  const liveDir = join(rootDir, sport);
  const tmpDir = join(rootDir, `${sport}.tmp`);
  const incomingDir = join(rootDir, `${sport}.incoming`);

  // Clear any leftover staging dirs from a crashed previous run.
  await rm(tmpDir, { recursive: true, force: true });
  await rm(incomingDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  // Write each non-null artifact + always write metadata last.
  if (artifacts.calibration) await writeAndFsync(join(tmpDir, "calibration.json"), artifacts.calibration);
  if (artifacts.defenseRatings) await writeAndFsync(join(tmpDir, "defenseRatings.json"), artifacts.defenseRatings);
  if (artifacts.breakoutProfiles) await writeAndFsync(join(tmpDir, "breakoutProfiles.json"), artifacts.breakoutProfiles);
  if (artifacts.gameScriptProfile) await writeAndFsync(join(tmpDir, "gameScriptProfile.json"), artifacts.gameScriptProfile);
  await writeAndFsync(join(tmpDir, "metadata.json"), artifacts.metadata);

  // Two-step rename: tmp → incoming, then remove live, then incoming → live.
  // Direct rename of tmp over a non-empty live dir isn't atomic on all FSes,
  // so we use the incoming-stage pattern.
  await rename(tmpDir, incomingDir);
  await rm(liveDir, { recursive: true, force: true });
  await rename(incomingDir, liveDir);
}
