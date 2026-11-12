import { describe, expect, it } from "vitest";
import { scriptOutputRpc } from "./contracts";

describe("runs.script-output contract", () => {
  it("takes a run and step id and returns the live tail and ended checks", () => {
    expect(scriptOutputRpc.name).toBe("runs.script-output");
    expect(scriptOutputRpc.input.parse({ runId: "r", stepId: "s" })).toEqual({ runId: "r", stepId: "s" });
    const output = { running: true, since: "2026-11-12T10:00:00Z", tail: "x", checks: [{ n: 1, startedAt: "a", endedAt: "b", outcome: "not_yet", exitCode: 75, tail: "y", trigger: "event:job.settled" }] };
    expect(scriptOutputRpc.output.parse(output)).toEqual(output);
    // A check without a trigger (older data) reads as a poll.
    const { trigger: _drop, ...bare } = output.checks[0]!;
    expect(scriptOutputRpc.output.parse({ ...output, checks: [bare] }).checks[0]!.trigger).toBe("poll");
    expect(() => scriptOutputRpc.input.parse({ runId: "r" })).toThrow();
  });
});
