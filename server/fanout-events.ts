import { z } from "zod";
import type { EventTypeDef } from "./bus";

/** The public events of fan-out steps (ADR 2026-11-13-fanout-replaced-child). */
export const FANOUT_TYPES: EventTypeDef[] = [
  {
    type: "fanout.child_replaced",
    description:
      "A child run of a fan-out item was replaced by a new run of the same playbook (replace_child, start_playbook replaces, or a restart of the run itself): the item keeps running under newRunId and the fan-out ends only when the last run of its chain does. runId is the parent run; replacedRunId and newRunId are the child runs (equal for a restart in place).",
    payload: z.object({
      runId: z.string(),
      stepId: z.string(),
      key: z.string(),
      replacedRunId: z.string(),
      newRunId: z.string(),
      reason: z.string().nullable(),
      restarts: z.number(),
    }),
    line: (event) => {
      const p = event.payload as { runId: string; stepId: string; key: string; replacedRunId: string; newRunId: string; reason: string | null; restarts: number };
      return `Fan-out "${p.stepId}" of run ${p.runId}: item "${p.key}" now runs as ${p.newRunId}, replacing ${p.replacedRunId} (restart ${p.restarts})${p.reason ? `: ${p.reason.slice(0, 200)}` : ""}. get_run on ${p.runId} lists the chain.`;
    },
  },
  {
    type: "fanout.refill",
    description:
      "A work pool's refill pass (a fan-out step with `pool`): phase started when the pass begins (doneKeys: the finished items it is given), ended when its items were applied or it failed. `added` are the keys of the children this pass created, which answers why a child appeared; items already present are ignored. runId is the parent run.",
    payload: z.object({
      runId: z.string(),
      stepId: z.string(),
      n: z.number(),
      phase: z.enum(["started", "ended"]),
      status: z.enum(["running", "completed", "failed", "canceled", "lost"]),
      passRunId: z.string().nullable(),
      doneKeys: z.array(z.string()),
      added: z.array(z.string()),
      skipped: z.number(),
      error: z.string().nullable(),
    }),
    line: (event) => {
      const p = event.payload as { runId: string; stepId: string; n: number; phase: "started" | "ended"; status: string; added: string[]; skipped: number; error: string | null; doneKeys: string[] };
      return p.phase === "started"
        ? `Fan-out "${p.stepId}" of run ${p.runId}: refill #${p.n} started (${p.doneKeys.length} item(s) done so far).`
        : `Fan-out "${p.stepId}" of run ${p.runId}: refill #${p.n} ${p.status}${p.error ? ` (${p.error.slice(0, 200)})` : ""}: ${p.added.length} added${p.added.length ? ` (${p.added.slice(0, 20).join(", ")})` : ""}${p.skipped ? `, ${p.skipped} already present` : ""}.`;
    },
  },
];
