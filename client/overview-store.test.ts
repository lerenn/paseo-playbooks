import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createOverviewStore } from "./overview-store";

/** A client whose RPCs resolve when the test says so, and whose agent list never emits. */
function fakeClient() {
  const calls: Array<{ name: string; resolve(value: unknown): void }> = [];
  const client = {
    paseo: { agents: { list: () => new Promise(() => undefined) } },
    rpc: (contract: { name: string }) => new Promise((resolve) => calls.push({ name: contract.name, resolve })),
  } as unknown as PluginClientContext;
  return { client, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const run = (pending: number) => ({ id: `r${pending}`, gates: Array.from({ length: pending }, () => ({ status: "pending" })) });

describe("overview store", () => {
  it("fetches only the count while no screen is open, and nothing before anything subscribes", async () => {
    const { client, calls } = fakeClient();
    const store = createOverviewStore(client);
    store.refresh();
    expect(calls).toHaveLength(0);
    const release = store.subscribe(() => undefined);
    expect(calls.map((call) => call.name)).toEqual(["overview.needs-you"]);
    calls[0]!.resolve({ count: 3 });
    await tick();
    expect(store.get()).toEqual({ count: 3, runs: null, badges: null, error: null });
    release();
    store.refresh();
    expect(calls).toHaveLength(1);
  });

  it("fetches runs while a screen is open, counts their gates, and merges refreshes in flight", async () => {
    const { client, calls } = fakeClient();
    const store = createOverviewStore(client);
    store.subscribe(() => undefined);
    const closeScreen = store.watchRuns();
    store.refresh();
    store.refresh();
    // The count request was in flight: one more request follows it, with runs.
    expect(calls.map((call) => call.name)).toEqual(["overview.needs-you"]);
    calls[0]!.resolve({ count: 0 });
    await tick();
    expect(calls.map((call) => call.name)).toEqual(["overview.needs-you", "overview.state"]);
    calls[1]!.resolve({ runs: [run(2), run(1)] });
    await tick();
    expect(store.get().count).toBe(3);
    expect(store.get().runs).toHaveLength(2);
    closeScreen();
    expect(store.get().runs).toBeNull();
    store.refresh();
    expect(calls[2]!.name).toBe("overview.needs-you");
  });

  it("uses compact data with sidebar rows, and returns to it when the screen closes", async () => {
    const { client, calls } = fakeClient();
    const store = createOverviewStore(client);
    const closeBadges = store.watchBadges();
    const unsubscribe = store.subscribe(() => undefined);
    expect(calls.map((call) => call.name)).toEqual(["overview.badges"]);
    calls[0]!.resolve({ count: 2, badges: [["w1", { run: { runId: "r1" } }]] });
    await tick();
    expect(store.get().badges?.get("w1")?.run.runId).toBe("r1");
    expect(store.get().count).toBe(2);
    expect(store.get().runs).toBeNull();

    const closeScreen = store.watchRuns();
    expect(calls[1]!.name).toBe("overview.state");
    calls[1]!.resolve({ runs: [] });
    await tick();
    expect(store.get().runs).toEqual([]);
    expect(store.get().badges?.size).toBe(0);
    closeScreen();
    store.refresh();
    expect(calls[2]!.name).toBe("overview.badges");

    closeBadges();
    calls[2]!.resolve({ count: 0, badges: [] });
    await tick();
    expect(store.get().badges).toBeNull();
    store.refresh();
    expect(calls[3]!.name).toBe("overview.needs-you");
    unsubscribe();
  });

  it("does not count a gate still with its role decider (advisor) until it escalates", async () => {
    const { client, calls } = fakeClient();
    const store = createOverviewStore(client);
    store.subscribe(() => undefined);
    store.watchRuns();
    calls[0]!.resolve({ count: 0 });
    await tick();
    const gate = (escalated: string | null) => ({ status: "pending", decider: { by: "role", role: "gatekeeper" }, escalated });
    calls[1]!.resolve({ runs: [{ id: "r", gates: [gate(null), gate("needs a human")] }] });
    await tick();
    expect(store.get().count).toBe(1);
  });

  it("does not refresh while the tab is in the background, and catches up once when it shows again", async () => {
    let state = "visible";
    const listeners = new Set<() => void>();
    vi.stubGlobal("document", {
      get visibilityState() {
        return state;
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    });
    try {
      const { client, calls } = fakeClient();
      const store = createOverviewStore(client);
      store.subscribe(() => undefined);
      calls[0]!.resolve({ count: 0 });
      await tick();
      state = "hidden";
      store.refresh();
      store.refresh();
      expect(calls).toHaveLength(1);
      state = "visible";
      for (const listener of listeners) listener();
      expect(calls).toHaveLength(2);
      for (const listener of listeners) listener();
      expect(calls).toHaveLength(2);
      store.dispose();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
