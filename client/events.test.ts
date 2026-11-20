import { describe, expect, it, vi } from "vitest";
import { watchAgents } from "./events";

type Update = { type: "agent_update"; payload: unknown };

function setup(workspaceId: string | null) {
  let handlers: { snapshot: (s: { entries: { agent: { id: string; workspaceId?: string } }[] }) => void; update: (m: Update) => void } | null = null;
  const release = vi.fn();
  const list = vi.fn(async (_options: unknown) => ({
    subscription: { subscribe: (h: typeof handlers) => ((handlers = h), () => undefined), release },
  }));
  const onChange = vi.fn();
  const stop = watchAgents({ agents: { list } } as never, workspaceId, onChange, 10);
  return { list, onChange, release, stop, handlers: () => handlers! };
}
const upsert = (id: string, workspaceId?: string): Update => ({ type: "agent_update", payload: { kind: "upsert", agent: { id, workspaceId } } });
const remove = (agentId: string): Update => ({ type: "agent_update", payload: { kind: "remove", agentId } });

describe("watchAgents", () => {
  it("asks for a one-agent snapshot and subscribes", async () => {
    const t = setup("w1");
    await vi.waitFor(() => expect(t.list).toHaveBeenCalled());
    expect(t.list).toHaveBeenCalledWith({ subscribe: {}, page: { limit: 1 } });
    t.stop();
  });

  it("ignores upserts outside the workspace and reports ones inside it", async () => {
    vi.useFakeTimers();
    const t = setup("w1");
    await vi.advanceTimersByTimeAsync(0);
    t.handlers().update(upsert("a", "w2"));
    t.handlers().update(upsert("b", undefined));
    await vi.advanceTimersByTimeAsync(50);
    expect(t.onChange).not.toHaveBeenCalled();
    t.handlers().update(upsert("c", "w1"));
    t.handlers().update(upsert("d", "w1"));
    await vi.advanceTimersByTimeAsync(50);
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.stop();
    vi.useRealTimers();
  });

  it("follows every workspace when null", async () => {
    vi.useFakeTimers();
    const t = setup(null);
    await vi.advanceTimersByTimeAsync(0);
    t.handlers().update(upsert("a", "w2"));
    await vi.advanceTimersByTimeAsync(50);
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.stop();
    vi.useRealTimers();
  });

  it("reports a remove even for an agent the one-agent snapshot never listed", async () => {
    vi.useFakeTimers();
    const t = setup("w1");
    await vi.advanceTimersByTimeAsync(0);
    t.handlers().update(remove("never-seen"));
    await vi.advanceTimersByTimeAsync(50);
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.stop();
    vi.useRealTimers();
  });

  it("releases the subscription when stopped before the list answers", async () => {
    let resolve!: (v: unknown) => void;
    const release = vi.fn();
    const list = vi.fn(() => new Promise((r) => (resolve = r)));
    const stop = watchAgents({ agents: { list } } as never, null, vi.fn(), 10);
    stop();
    resolve({ subscription: { subscribe: vi.fn(), release } });
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
  });

  it("releases on stop after subscribing", async () => {
    const t = setup(null);
    await vi.waitFor(() => expect(t.release).not.toBeUndefined());
    await vi.waitFor(() => expect(t.list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    t.stop();
    expect(t.release).toHaveBeenCalled();
  });
});
