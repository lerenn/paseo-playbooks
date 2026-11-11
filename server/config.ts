import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_REPO } from "../shared/repos";

/** `$PASEO_HOME/plugin-data/paseo-playbooks/config.yaml`: the user's settings (profile activation is per project). */
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The profiles a project has turned on: `profiles.projects.<project>.active` of the user config. It applies to every
 * workspace of the project. Anything malformed, `default` and repeats are dropped: a bad config never blocks loading.
 * The old global `profiles.active` is ignored: a project without an entry has no profile active.
 */
export async function readProjectProfiles(projectId: string, file: string = userConfigFile()): Promise<string[]> {
  const projects = asRecord(asRecord((await readConfig(file)).profiles).projects);
  const active = Object.hasOwn(projects, projectId) ? asRecord(projects[projectId]).active : undefined;
  if (!Array.isArray(active)) return [];
  return [...new Set(active.filter((id): id is string => typeof id === "string" && id !== DEFAULT_REPO))];
}

/**
 * Whether the project's `default` repository is on: `profiles.projects.<project>.default` of the user config. It is on
 * unless that is exactly `false`, so a project without an entry (every existing user) keeps it.
 */
export async function readProjectDefault(projectId: string, file: string = userConfigFile()): Promise<boolean> {
  const projects = asRecord(asRecord((await readConfig(file)).profiles).projects);
  return !(Object.hasOwn(projects, projectId) && asRecord(projects[projectId]).default === false);
}

/**
 * Turns a profile on or off for a project, keeping the rest of the config; returns the project's new list of active
 * profiles. `default` is not a list entry: turning it off writes `default: false`, turning it on removes that key.
 */
export async function setProjectProfile(projectId: string, profile: string, active: boolean, file: string = userConfigFile()): Promise<string[]> {
  const config = await readConfig(file);
  const current = await readProjectProfiles(projectId, file);
  const profiles = asRecord(config.profiles);
  const projects = asRecord(profiles.projects);
  const entry = { ...asRecord(projects[projectId]) };
  let next = current;
  if (profile === DEFAULT_REPO) {
    if (active) delete entry.default;
    else entry.default = false;
  } else {
    next = active ? [...new Set([...current, profile])] : current.filter((id) => id !== profile);
    entry.active = next;
  }
  config.profiles = { ...profiles, projects: { ...projects, [projectId]: entry } };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, stringifyYaml(config), "utf8");
  await rename(tmp, file);
  return next;
}
