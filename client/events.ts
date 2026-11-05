import { usePaseo, type PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";

type PaseoApi = PluginClientContext["paseo"];

/**
 * Calls `onChange` (batched over `batchMs`) when an agent changes: a step agent created or
 * finishing, a manager starting or ending a turn, or answering a gate in chat. Run state changes
 * with those events, and the plugin SDK has no way to push its own events to the client.
 * `workspaceId` limits it to the agents of one workspace; null follows every workspace.
 * Returns a function that stops it.
 */
export function watchAgents(paseo: PaseoApi, workspaceId: string | null, onChange: () => void, batchMs: number): () => void {
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ours = new Set<string>();
  const mine = (agentWorkspaceId: string | undefined) => workspaceId === null || agentWorkspaceId === workspaceId;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, batchMs);
  };
  void paseo.agents
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return void subscription.release();
      const stop = subscription.subscribe({
        snapshot: ({ entries }) => {
          ours.clear();
          for (const { agent } of entries) if (mine(agent.workspaceId)) ours.add(agent.id);
          changed();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            if (!mine(update.agent.workspaceId)) return;
            ours.add(update.agent.id);
            changed();
          } else if (ours.delete(update.agentId)) {
            changed();
          }
        },
      });
      lifetime.signal.addEventListener("abort", () => {
        stop();
        void subscription.release();
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[playbooks] agent events failed", error);
    });
  return () => {
    lifetime.abort();
    if (timer) clearTimeout(timer);
  };
}

/** `watchAgents` for a component: follows one workspace while mounted. */
export function useAgentEvents(workspaceId: string, onChange: () => void, batchMs = 400): void {
  const paseo = usePaseo();
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => watchAgents(paseo, workspaceId, () => latest.current(), batchMs), [paseo, workspaceId, batchMs]);
}
