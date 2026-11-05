import { describe, expect, it } from "vitest";
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
    expect(store.get()).toEqual({ count: 3, runs: null, error: null });
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
});
