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

/** Turns a profile on or off for a project, keeping the rest of the config; returns the project's new list. */
export async function setProjectProfile(projectId: string, profile: string, active: boolean, file: string = userConfigFile()): Promise<string[]> {
  if (profile === DEFAULT_REPO) return readProjectProfiles(projectId, file);
  const config = await readConfig(file);
  const current = await readProjectProfiles(projectId, file);
  const next = active ? [...new Set([...current, profile])] : current.filter((id) => id !== profile);
  const profiles = asRecord(config.profiles);
  const projects = asRecord(profiles.projects);
  config.profiles = { ...profiles, projects: { ...projects, [projectId]: { ...asRecord(projects[projectId]), active: next } } };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, stringifyYaml(config), "utf8");
  await rename(tmp, file);
  return next;
}
