/**
 * Workspace lookups by id, shared by the whole plugin.
 *
 * The SDK's `workspaces.ref(id).refresh()` pages the daemon's whole workspace list on every call: no cache, no
 * by-id request. Under load that flooded the daemon with `fetch_workspaces` (each one rebuilds every descriptor),
 * so the plugin's own RPCs timed out. Here one fetch of the full list serves every id: concurrent lookups share
 * it (single-flight), the result is kept for a short while, and it is dropped when the plugin creates or archives
 * a workspace or the daemon reports one. A lookup that misses (a workspace created elsewhere) may force one fresh
 * fetch, at most once per `missRefetchMs`.
 */
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];
export type WorkspaceInfo = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];

export const WORKSPACE_TTL_MS = 15_000;
export const WORKSPACE_MISS_REFETCH_MS = 3_000;
const PAGE_SIZE = 200;

/**
 * What `@getpaseo/client` throws, before sending anything, when asked for background workspaces of a host that lacks
 * them (`requireBackgroundWorkspaces` in daemon-client.js; the SDK's own `ref().refresh()` checks
 * `supportsBackgroundWorkspaces()` for the same condition). The only error that permits the unfiltered request.
 */
export const BACKGROUND_UNSUPPORTED = "Update the host to use background workspaces.";

/** Every workspace the daemon lists, background ones included when the daemon supports them (as `ref().refresh()` does). */
export async function fetchAllWorkspaces(paseo: PaseoApi): Promise<WorkspaceInfo[]> {
  const listAll = async (filter: { includeBackground: true } | undefined) => {
    const all: WorkspaceInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.workspaces.list({ ...(filter ? { filter } : {}), page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
      all.push(...page.entries);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return all;
  };
  // Only a host that positively lacks background workspaces gets the plain list. Any other failure (timeout, network)
  // propagates: the plain list omits hidden Sidekick workspaces, and a partial list must never stand for the whole.
  return listAll({ includeBackground: true }).catch((error: unknown) => {
    if (error instanceof Error && error.message === BACKGROUND_UNSUPPORTED) return listAll(undefined);
    throw error;
  });
}

export class WorkspaceLookup {
  private cache: { byId: Map<string, WorkspaceInfo>; at: number } | null = null;
  private inflight: Promise<Map<string, WorkspaceInfo>> | null = null;
  /** Bumped by `invalidate`: a fetch started before it must not fill the cache. */
  private generation = 0;

  constructor(
    private readonly fetchAll: () => Promise<WorkspaceInfo[]>,
    private readonly options: { ttlMs?: number; missRefetchMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * The workspace, or null when it is not listed. Rejects when the daemon cannot be asked.
   * Without `confirm`, a null may be a throttled miss (the cached list is younger than `missRefetchMs`): fine for hot,
   * non-critical paths. With `confirm`, a null always comes from a fresh fetch, so it is safe to act on as "does not exist".
   */
  async get(id: string, options: { confirm?: boolean } = {}): Promise<WorkspaceInfo | null> {
    const ttl = this.options.ttlMs ?? WORKSPACE_TTL_MS;
    const missGap = this.options.missRefetchMs ?? WORKSPACE_MISS_REFETCH_MS;
    const cached = this.cache;
    if (cached && this.now() - cached.at < ttl) {
      const hit = cached.byId.get(id);
      if (hit) return hit;
      // Not listed: maybe created since. Look again, but not on every miss.
      if (!options.confirm && this.now() - cached.at < missGap) return null;
    }
    return (await this.load()).get(id) ?? null;
  }

  /** Forget the list: the next lookup fetches it again (a workspace was created, archived or renamed). */
  invalidate(): void {
    this.generation++;
    this.cache = null;
    this.inflight = null;
  }

  private load(): Promise<Map<string, WorkspaceInfo>> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const started = this.now();
    const run = this.fetchAll()
      .then((entries) => {
        const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
        if (generation === this.generation) this.cache = { byId, at: started };
        return byId;
      })
      .finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    this.inflight = run;
    return run;
  }
}
