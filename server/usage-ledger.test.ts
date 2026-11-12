import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsageLedger } from "./usage-ledger";

const info = { title: "Manager", kind: "manager", role: null, model: "claude/opus", runId: "r1" };
const reading = (input: number, cached: number, ctx = 1000) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: 10, contextWindowUsedTokens: ctx });

describe("UsageLedger", () => {
  it("turns cumulative readings into per-turn deltas, so a long session is not counted once per turn", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-"));
    const ledger = new UsageLedger(path.join(dir, "agent-usage.json"));
    expect(await ledger.record("a", info, reading(1, 100))).toMatchObject({ inputTokens: 1, cachedInputTokens: 100 });
    expect(await ledger.record("a", info, reading(3, 250, 5000))).toMatchObject({ inputTokens: 2, cachedInputTokens: 150 });
    const [entry] = await ledger.list();
    expect(entry!.usage).toMatchObject({ turns: 2, inputTokens: 3, cachedInputTokens: 250, outputTokens: 10, contextPeak: 5000 });
  });

  it("starts over when a counter goes down, and survives a reload from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-"));
    const file = path.join(dir, "agent-usage.json");
    const ledger = new UsageLedger(file);
    await ledger.record("a", info, reading(5, 500));
    await ledger.record("a", info, reading(1, 50));
    await ledger.flush();
    const again = new UsageLedger(file);
    await again.record("a", info, reading(2, 80));
    const [entry] = await again.list();
    expect(entry!.usage).toMatchObject({ turns: 3, inputTokens: 7, cachedInputTokens: 580 });
  });

  it("sums cumulative input tokens over three turns to the final count, across runs of the same manager", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-"));
    const ledger = new UsageLedger(path.join(dir, "agent-usage.json"));
    const deltas = [
      await ledger.record("m", { ...info, runId: "r1" }, reading(10, 0)),
      await ledger.record("m", { ...info, runId: "r1" }, reading(25, 0)),
      await ledger.record("m", { ...info, runId: "r2" }, reading(40, 0)),
    ].map((d) => d.inputTokens);
    expect(deltas).toEqual([10, 15, 15]);
    expect((await ledger.list())[0]!.usage.inputTokens).toBe(40);
  });
});
