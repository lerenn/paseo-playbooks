/**
 * Most server tests drive the runtime with a fake daemon whose `workspaces.ref(id).refresh()` answers per id and
 * that has no workspace list. This setup keeps that behaviour for them by replacing the shared workspace lookup
 * (server/workspace-lookup.ts) with a per-id passthrough. The real one is covered by server/workspace-lookup.test.ts,
 * which imports it with `vi.importActual`.
 */
import { vi } from "vitest";

vi.mock("../server/workspace-lookup", () => {
  type Fake = { workspaces: { ref: (id: string) => { refresh: () => Promise<unknown> } } };
  let paseo: Fake | null = null;
  return {
    WORKSPACE_TTL_MS: 15_000,
    WORKSPACE_MISS_REFETCH_MS: 3_000,
    fetchAllWorkspaces: async (api: Fake) => {
      paseo = api;
      return [];
    },
    WorkspaceLookup: class {
      constructor(private readonly fetchAll: () => Promise<unknown[]>) {}
      async get(id: string) {
        await this.fetchAll();
        return ((await paseo!.workspaces.ref(id).refresh()) ?? null) as never;
      }
      invalidate() {}
    },
  };
});
