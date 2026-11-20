import { usePaseo, type PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";

type PaseoApi = PluginClientContext["paseo"];

/**
 * Calls `onChange` (batched over `batchMs`) when an agent changes: a step agent created or
 * finishing, a manager starting or ending a turn, or answering a gate in chat. Run state changes
 * with those events, and the plugin SDK has no way to push its own events to the client.
 * `workspaceId` limits it to the agents of one workspace; null follows every workspace.
 * Returns a function that stops it.
 *
 * The snapshot is asked for a single agent (`page.limit` 1): the daemon's live agent_update stream
 * is cut by the request's `filter` only, never by `page` or `scope` (those shape just the first
 * snapshot), and the filter cannot select a workspace, so the full 200-agent snapshot (about 1.3 MB
 * per connect and resume) would buy nothing. Membership is therefore learned from upserts, and a
 * remove (which carries only an id and is also sent when an agent stops matching, e.g. an internal
 * helper) always counts as a change, since an agent never seen in the snapshot cannot be told apart.
 */
export function watchAgents(paseo: PaseoApi, workspaceId: string | null, onChange: () => void, batchMs: number): () => void {
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const mine = (agentWorkspaceId: string | undefined) => workspaceId === null || agentWorkspaceId === workspaceId;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, batchMs);
  };
  void paseo.agents
    .list({ subscribe: {}, page: { limit: 1 } })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return void subscription.release();
      const stop = subscription.subscribe({
        snapshot: () => changed(),
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            if (!mine(update.agent.workspaceId)) return;
            changed();
          } else {
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
