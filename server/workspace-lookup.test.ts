import { describe, expect, it, vi } from "vitest";
import type * as Lookup from "./workspace-lookup";

// The setup file replaces the module for the other tests; this one tests the real thing.
const { fetchAllWorkspaces, WorkspaceLookup, BACKGROUND_UNSUPPORTED } = await vi.importActual<typeof Lookup>("./workspace-lookup");
type WorkspaceInfo = Lookup.WorkspaceInfo;

const ws = (id: string) => ({ id, projectId: "p", projectRootPath: "/p" }) as unknown as WorkspaceInfo;

function setup(initial: string[] = ["a", "b"]) {
  let ids = initial;
  let clock = 1_000;
  const fetchAll = vi.fn(async () => ids.map(ws));
  const lookup = new WorkspaceLookup(fetchAll, { ttlMs: 15_000, missRefetchMs: 3_000, now: () => clock });
  return { lookup, fetchAll, set: (next: string[]) => void (ids = next), advance: (ms: number) => void (clock += ms) };
}

describe("WorkspaceLookup", () => {
  it("serves N concurrent lookups of different ids with one fetch", async () => {
    const { lookup, fetchAll } = setup();
    const found = await Promise.all(Array.from({ length: 20 }, (_, i) => lookup.get(i % 2 ? "a" : "b")));
    expect(found.map((w) => w?.id)).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 ? "a" : "b")));
    expect(fetchAll).toHaveBeenCalledTimes(1);
  });

  it("reuses the list until the TTL expires, then fetches again", async () => {
    const { lookup, fetchAll, advance } = setup();
    await lookup.get("a");
    advance(14_000);
    await lookup.get("b");
    expect(fetchAll).toHaveBeenCalledTimes(1);
    advance(1_500);
    await lookup.get("a");
    expect(fetchAll).toHaveBeenCalledTimes(2);
  });

  it("a miss returns null; a later miss past the gap refreshes once, and finds a new workspace", async () => {
    const { lookup, fetchAll, set, advance } = setup();
    expect(await lookup.get("a")).not.toBeNull();
    set(["a", "b", "c"]);
    // Inside the gap since the last fetch: no new fetch, same answer as today for an unknown id.
    expect(await lookup.get("c")).toBeNull();
    expect(fetchAll).toHaveBeenCalledTimes(1);
    advance(3_000);
    const [first, second] = await Promise.all([lookup.get("c"), lookup.get("c")]);
    expect(first?.id).toBe("c");
    expect(second?.id).toBe("c");
    expect(fetchAll).toHaveBeenCalledTimes(2);
    // A workspace that does not exist is bounded: one refresh per gap, not one per lookup.
    advance(3_000);
    await Promise.all([lookup.get("zzz"), lookup.get("zzz"), lookup.get("yyy")]);
    await lookup.get("zzz");
    expect(fetchAll).toHaveBeenCalledTimes(3);
  });

  it("a throttled miss is uncertain: a confirmed lookup fetches fresh and finds a workspace restored without an event", async () => {
    const { lookup, fetchAll, set } = setup(["a"]);
    await lookup.get("a");
    set(["a", "c"]);
    expect(await lookup.get("c")).toBeNull();
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect((await lookup.get("c", { confirm: true }))?.id).toBe("c");
    expect(fetchAll).toHaveBeenCalledTimes(2);
    // Confirmed absence is a fresh fetch's answer.
    expect(await lookup.get("zzz", { confirm: true })).toBeNull();
    expect(fetchAll).toHaveBeenCalledTimes(3);
  });

  it("a confirmed hit costs no fetch", async () => {
    const { lookup, fetchAll } = setup(["a"]);
    await lookup.get("a");
    expect((await lookup.get("a", { confirm: true }))?.id).toBe("a");
    expect(fetchAll).toHaveBeenCalledTimes(1);
  });

  it("invalidate (create, archive) makes the next lookup fetch again", async () => {
    const { lookup, fetchAll, set } = setup();
    expect((await lookup.get("a"))?.id).toBe("a");
    set(["b", "c"]);
    lookup.invalidate();
    expect(await lookup.get("a")).toBeNull();
    expect((await lookup.get("c"))?.id).toBe("c");
    expect(fetchAll).toHaveBeenCalledTimes(2);
  });

  it("a fetch in flight when invalidate is called does not fill the cache", async () => {
    let release!: (value: WorkspaceInfo[]) => void;
    const fetchAll = vi.fn()
      .mockImplementationOnce(() => new Promise<WorkspaceInfo[]>((resolve) => void (release = resolve)))
      .mockResolvedValue([ws("fresh")]);
    const lookup = new WorkspaceLookup(fetchAll, { now: () => 0 });
    const stale = lookup.get("old");
    lookup.invalidate();
    release([ws("old")]);
    expect((await stale)?.id).toBe("old");
    expect((await lookup.get("fresh"))?.id).toBe("fresh");
    expect(fetchAll).toHaveBeenCalledTimes(2);
  });

  it("not found is null and a failed fetch rejects without being cached", async () => {
    const fetchAll = vi.fn().mockRejectedValueOnce(new Error("daemon down")).mockResolvedValue([ws("a")]);
    const lookup = new WorkspaceLookup(fetchAll, { now: () => 0 });
    await expect(lookup.get("a")).rejects.toThrow("daemon down");
    expect((await lookup.get("a"))?.id).toBe("a");
    expect(await lookup.get("nope")).toBeNull();
  });
});

describe("fetchAllWorkspaces", () => {
  it("pages the whole list with background workspaces included", async () => {
    const list = vi.fn(async (options: { page: { cursor?: string } }) =>
      options.page.cursor ? { entries: [ws("c")], pageInfo: { nextCursor: null } } : { entries: [ws("a"), ws("b")], pageInfo: { nextCursor: "next" } },
    );
    const all = await fetchAllWorkspaces({ workspaces: { list } } as never);
    expect(all.map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]![0]).toMatchObject({ filter: { includeBackground: true } });
  });

  it("falls back to the plain list only when the client says the host has no background workspaces", async () => {
    const list = vi.fn(async (options: { filter?: unknown }) => {
      if (options.filter) throw new Error(BACKGROUND_UNSUPPORTED);
      return { entries: [ws("a")], pageInfo: { nextCursor: null } };
    });
    expect((await fetchAllWorkspaces({ workspaces: { list } } as never)).map((w) => w.id)).toEqual(["a"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("propagates an operational failure (timeout, network) instead of retrying without the background workspaces", async () => {
    const list = vi.fn(async (options: { filter?: unknown }) => {
      if (options.filter) throw new Error("Timed out waiting for fetch_workspaces_response");
      return { entries: [ws("visible")], pageInfo: { nextCursor: null } };
    });
    await expect(fetchAllWorkspaces({ workspaces: { list } } as never)).rejects.toThrow(/Timed out/);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
