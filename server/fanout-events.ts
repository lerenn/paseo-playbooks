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
];
