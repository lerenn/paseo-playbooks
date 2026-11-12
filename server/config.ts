import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { pluginDataDir } from "./data-dir";
import { DEFAULT_REPO } from "../shared/repos";

/** `<plugin data dir>/config.yaml` (data-dir.ts): the user's settings (profile activation is per project). */
export function userConfigFile(): string {
  return path.join(pluginDataDir(), "config.yaml");
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

/** `event_core` of the user config (ADR 2026-11-12-event-core): the event log and its parity check. */
export interface EventCoreConfig {
  /** Write the per-run event log (`<run>.events.jsonl`). Off: no log file is written and no parity is checked; run state is unchanged either way. */
  log: boolean;
  /** `warn`: compare what the reducers rebuild with the state the mutators produced, log a mismatch; `off`: no check. */
  parity: "warn" | "off";
}

export const DEFAULT_EVENT_CORE: EventCoreConfig = { log: true, parity: "warn" };

/**
 * `event_core: { log: true | false, parity: warn | off }`. Anything missing or malformed falls back to the default
 * (log on, parity warn): a bad config never blocks loading. Read once when the plugin starts.
 */
export async function readEventCoreConfig(file: string = userConfigFile()): Promise<EventCoreConfig> {
  const block = asRecord((await readConfig(file)).event_core);
  return {
    log: typeof block.log === "boolean" ? block.log : DEFAULT_EVENT_CORE.log,
    parity: block.parity === "off" ? "off" : DEFAULT_EVENT_CORE.parity,
  };
}
