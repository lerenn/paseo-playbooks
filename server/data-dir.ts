import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function pluginDataRoot(): string {
  return path.join(process.env.PASEO_HOME || path.join(homedir(), ".paseo"), "plugin-data");
}

/** `$PASEO_HOME/plugin-data/lerenn/paseo-playbooks`, namespaced by owner so another plugin of the same name cannot collide. */
export function dataDir(): string {
  return path.join(pluginDataRoot(), "lerenn", "paseo-playbooks");
}

/** `$PASEO_HOME/plugin-data/paseo-playbooks`: where versions before 0.71 kept their data. */
export function legacyDataDir(): string {
  return path.join(pluginDataRoot(), "paseo-playbooks");
}

/** The directory in use: the namespaced one, or the old one while it holds the data and the move has not happened (or failed). */
export function pluginDataDir(): string {
  return !existsSync(dataDir()) && existsSync(legacyDataDir()) ? legacyDataDir() : dataDir();
}

/**
 * Moves the old data directory to the namespaced one and leaves a symlink at the old path, so paths recorded in
 * run files (isolated worktrees) and older plugin versions keep resolving. Does nothing when there is no old data,
 * the new directory already exists, or the move fails (the old directory then stays in use, see `pluginDataDir`).
 */
export function migrateDataDir(): void {
  const from = legacyDataDir();
  const to = dataDir();
  if (!existsSync(from) || existsSync(to)) return;
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
  } catch (error) {
    console.error("[playbooks] could not move the data directory, keeping the old one:", (error as Error).message);
    return;
  }
  try {
    symlinkSync(to, from, "dir");
  } catch (error) {
    console.error("[playbooks] moved the data directory but could not link the old path:", (error as Error).message);
  }
}
