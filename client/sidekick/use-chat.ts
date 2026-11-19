import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { promptWithFiles } from "../../shared/attachments";
import { saveSidekickAttachmentRpc } from "../../shared/contracts";
import type { Pending } from "./attach";
import { initialState, reduce, type PermissionRequest, type RawItem, type WindowInfo } from "./reduce";
import { FIRST_PAGE, OLDER_PAGE, RELOAD_PAGE } from "./window";

export type PermissionResponse =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: Record<string, unknown>[] }
  | { behavior: "deny"; message?: string };

export interface AgentInfo {
  model: string | null;
  mode: string | null;
}

function windowOf(page: { epoch: string; startCursor?: { epoch: string; seq: number } | null; hasOlder: boolean }): WindowInfo {
  return { epoch: page.epoch, startCursor: page.startCursor ?? null, hasOlder: page.hasOlder };
}

/**
 * The live chat of one agent: a snapshot of its timeline, then its live events (re-read after a
 * reconnect or a replaced timeline), plus send, stop and permission answers.
 */
export function useSidekickChat(agentId: string | null) {
  const paseo = usePaseo();
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [info, setInfo] = useState<AgentInfo>({ model: null, mode: null });
  const generation = useRef(0);
  const handleRef = useRef<ReturnType<typeof paseo.agents.ref> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The page being read (one at a time, never the same cursor twice).
  const olderInFlight = useRef(false);
  const saveAttachment = useRpc(saveSidekickAttachmentRpc);

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!agentId) return;
    const mine = ++generation.current;
    const stale = () => generation.current !== mine;
    const handle = paseo.agents.ref(agentId);
    handleRef.current = handle;
    olderInFlight.current = false;
    let release: (() => void | Promise<void>) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    let loadedOnce = false;
    const load = async () => {
      // A small first page for a fast first paint; a re-read (after a reconnect) is wide enough to cover what was missed.
      const page = await handle.timeline.refetch({ direction: "tail", limit: loadedOnce ? RELOAD_PAGE : FIRST_PAGE });
      if (stale()) return;
      loadedOnce = true;
      dispatch({ type: "refetch", items: page.entries.map((entry) => ({ key: `seq:${entry.seqStart}`, item: entry.item as unknown as RawItem })), span: windowOf(page) });
      const snapshot = await handle.refresh();
      if (stale() || !snapshot) return;
      const agent = snapshot.agent as unknown as { status?: string; activeTurn?: unknown; pendingPermissions?: PermissionRequest[]; currentModeId?: string | null; model?: string | null; provider?: string };
      dispatch({ type: "snapshot", running: agent.activeTurn != null || agent.status === "running", permissions: (agent.pendingPermissions ?? []) as PermissionRequest[] });
      setInfo({ model: agent.model ?? agent.provider ?? null, mode: agent.currentModeId ?? null });
    };

    const start = async () => {
      if (stale()) return;
      try {
        const sub = handle.timeline.subscribe((message) => {
          if (stale()) return;
          const payload = message as unknown as { event: { type: string } & Record<string, unknown> };
          const event = payload.event;
          if (event.type === "replacement" || event.type === "subscription_restored") {
            void load().catch(() => undefined);
          } else if (event.type === "error") {
            dispatch({ type: "connection", status: "error", error: String(event.error ?? "Subscription error") });
            void release?.();
            retry = setTimeout(() => void start(), 4000);
          } else {
            dispatch({ type: "event", event: event as never });
          }
        });
        release = () => (sub as unknown as { release?: () => void }).release?.();
        await (sub as unknown as { ready?: Promise<void> }).ready?.catch(() => undefined);
        // Subscribe first, then read: events that arrive meanwhile are not lost.
        await load();
        if (!stale()) dispatch({ type: "connection", status: "live" });
      } catch (error) {
        if (stale()) return;
        dispatch({ type: "connection", status: "error", error: error instanceof Error ? error.message : String(error) });
        retry = setTimeout(() => void start(), 4000);
      }
    };
    void start();

    // A permission is resolved elsewhere (the native tab): it arrives as its own message, not in the timeline.
    const observation = paseo.observeEvents(["agent_permission_resolved"]);
    const unobserve = observation.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type === "agent_permission_resolved" && message.payload.agentId === agentId) dispatch({ type: "permission_resolved", requestId: message.payload.requestId });
      },
    });
    return () => {
      generation.current += 1;
      if (retry) clearTimeout(retry);
      void release?.();
      unobserve();
      void observation.release().catch(() => undefined);
    };
  }, [agentId, paseo]);

  /** Reads the page of entries before the oldest one shown. Called when the reader nears the top. */
  const loadOlder = useCallback(async () => {
    const current = stateRef.current.older;
    const handle = handleRef.current;
    if (!handle || olderInFlight.current || !current.hasMore || !current.cursor) return;
    olderInFlight.current = true;
    const mine = generation.current;
    dispatch({ type: "older_start" });
    try {
      const page = await handle.timeline.refetch({ direction: "before", cursor: current.cursor, limit: OLDER_PAGE });
      if (generation.current !== mine) return;
      if (page.staleCursor || page.reset) {
        dispatch({ type: "older_failed" });
        return;
      }
      dispatch({ type: "older", items: page.entries.map((entry) => ({ key: `seq:${entry.seqStart}`, item: entry.item as unknown as RawItem })), from: current.cursor.seq, span: windowOf(page) });
    } catch {
      if (generation.current === mine) dispatch({ type: "older_failed" });
    } finally {
      olderInFlight.current = false;
    }
  }, []);

  /**
   * Sends a message. Images go as image content blocks, like Paseo's own composer; any other file is
   * saved on the host and its path is added to the text.
   */
  const send = useCallback(
    async (text: string, attachments: Pending[] = []) => {
      if (!agentId) return;
      const images = attachments.filter((item) => item.kind === "image").map((item) => ({ data: item.dataBase64, mimeType: item.mimeType }));
      const files = await Promise.all(
        attachments.filter((item) => item.kind === "file").map(async (item) => ({ name: item.name, path: (await saveAttachment({ fileName: item.name, dataBase64: item.dataBase64 })).path })),
      );
      // Mid-turn the message steers the turn instead of interrupting it.
      dispatch({ type: "steer_sent" });
      await paseo.agents.ref(agentId).send(promptWithFiles(text, files, images.length), { activeTurnBehavior: "steer", ...(images.length > 0 ? { images } : {}) });
    },
    [agentId, paseo, saveAttachment],
  );

  /** The SDK has no stop for an agent: reloading its session interrupts the running turn. */
  const stop = useCallback(async () => {
    if (agentId) await paseo.agents.ref(agentId).reload();
  }, [agentId, paseo]);

  const respond = useCallback(
    async (requestId: string, response: PermissionResponse) => {
      if (!agentId) return;
      await paseo.agents.ref(agentId).respondToPermission({ requestId, response });
      dispatch({ type: "permission_resolved", requestId });
    },
    [agentId, paseo],
  );

  return { state, info, send, stop, respond, loadOlder };
}
