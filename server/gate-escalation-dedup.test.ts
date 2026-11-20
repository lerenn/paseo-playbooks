import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Playbook, Run } from "../shared/types";
import { newRun } from "./engine";
import { loadPlaybooks } from "./loader";
import { OversightProducer } from "./oversight-events";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
let playbook: Playbook;
beforeAll(async () => {
  playbook = (await loadPlaybooks(EXAMPLES)).entries.find((entry) => entry.id === "pr")!.playbook!;
});

const NOW = Date.parse("2026-11-20T12:00:00Z");

function gate(status: "rejected" | "pending", escalated: string | null) {
  return {
    id: "loop-babysit-implement-8", kind: "loop_limit", stepId: "babysit", gotoTarget: "implement", jobId: null, outcome: null, status,
    message: "Loop limit reached", summary: "Loop limit reached", details: "", requestedAt: new Date(NOW - 3_600_000).toISOString(), comment: null,
    decidedBy: status === "rejected" ? "chat" : null, decidedVia: status === "rejected" ? "chat" : null, decidedAt: status === "rejected" ? new Date(NOW - 3_000_000).toISOString() : null,
    decider: { by: "manager" }, deciderAgentId: null, escalated, escalatedAt: escalated ? new Date(NOW - 1_000_000).toISOString() : null,
  };
}

/** A bus that records what is emitted. */
function fakeBus() {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bus = {
    recent: async () => ({ events: [], lastSeq: 0, oldestSeq: null }),
    thresholds: async () => [],
    emit: async (type: string, payload: Record<string, unknown>) => void emitted.push({ type, payload }),
  };
  return { bus, emitted };
}

describe("gate.escalated is announced once per pending gate", () => {
  it("a run saved with a rejected and a pending gate under one id (the id was reused after restart_run) does not re-announce the new gate on every scan", async () => {
    const { bus, emitted } = fakeBus();
    const producer = new OversightProducer(bus as never);
    const run: Run = newRun({ id: "run_x", playbook, workspaceId: "ws", workspaceDir: "/tmp/ws", projectId: "p", branch: null, managerAgentId: "m", inputs: { request: "x" }, now: new Date(NOW - 7_200_000).toISOString() });
    run.gates.push(gate("rejected", null) as never, gate("pending", "the manager left it to a human") as never);
    run.status = "waiting_gate";
    await producer.scan([run], NOW); // seeding
    for (let scan = 1; scan <= 6; scan++) await producer.scan([run], NOW + scan * 60_000);
    // Seeding does not announce; the later scans must announce neither the gate nor its escalation again and again.
    expect(emitted.filter((event) => event.type === "gate.escalated").length).toBeLessThanOrEqual(1);
    expect(emitted.filter((event) => event.type === "gate.opened").length).toBeLessThanOrEqual(1);
    expect(emitted.filter((event) => event.type === "gate.decided")).toEqual([]);
  });
});
