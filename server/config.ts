import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_REPO } from "../shared/repos";

/** `$PASEO_HOME/plugin-data/paseo-playbooks/config.yaml`: the user's settings, global to every workspace. */
export function userConfigFile(): string {
  const home = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
  return path.join(home, "plugin-data", "paseo-playbooks", "config.yaml");
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const value = parseYaml(await readFile(file, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `profiles.active` of the user config. Anything malformed, `default` and repeats are dropped: a bad config never blocks loading. */
export async function readActiveProfiles(file: string = userConfigFile()): Promise<string[]> {
  const profiles = (await readConfig(file)).profiles;
  const active = profiles !== null && typeof profiles === "object" ? (profiles as { active?: unknown }).active : undefined;
  if (!Array.isArray(active)) return [];
  return [...new Set(active.filter((id): id is string => typeof id === "string" && id !== DEFAULT_REPO))];
}

/** Turns a profile on or off, keeping the rest of the config; returns the new `profiles.active`. */
export async function setProfileActive(profile: string, active: boolean, file: string = userConfigFile()): Promise<string[]> {
  if (profile === DEFAULT_REPO) return readActiveProfiles(file);
  const config = await readConfig(file);
  const current = await readActiveProfiles(file);
  const next = active ? [...new Set([...current, profile])] : current.filter((id) => id !== profile);
  const profiles = config.profiles !== null && typeof config.profiles === "object" ? (config.profiles as Record<string, unknown>) : {};
  config.profiles = { ...profiles, active: next };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, stringifyYaml(config), "utf8");
  await rename(tmp, file);
  return next;
}
