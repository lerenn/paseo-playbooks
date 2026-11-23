import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext, PluginText } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { headerStateRpc } from "../shared/contracts";
import { messages } from "./i18n";
import { isHidden, onVisible } from "./visibility";
import { semanticColor } from "./semantic-colors";

/** How often the buttons refresh which workspaces have playbooks or a waiting gate. */
const POLL_MS = 10_000;
/**
 * Workspace events arrive in a burst (a fresh connection upserts every workspace, and a git
 * refresh on the host follows each one), so new workspaces wait this long and are asked about in
 * one request.
 */
const NEW_WORKSPACES_BATCH_MS = 300;

/** The Playbooks icon with a dot in the theme's warning colour: a run waits for a decision. */
function WaitingIcon(props: PluginButtonIconProps) {
  const size = props.size ?? 16;
  const dot = Math.max(6, Math.round(size * 0.45));
  return (
    <View style={{ width: size, height: size }}>
      <Icon name="Workflow" size={size} color={props.color} />
      <View
        style={{
          position: "absolute",
          top: -dot / 4,
          right: -dot / 4,
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: semanticColor(props.theme, "waiting"),
          borderWidth: 1,
          borderColor: props.theme.colors.surface0,
        }}
      />
    </View>
  );
}

/**
 * Adds a Playbooks button to the header of every workspace that has playbooks. It opens the
 * Playbooks tab and shows a dot while a run there waits for a gate decision.
 */
export function contributeHeaderButtons(client: PluginClientContext): () => void {
  type Button = { registration: PluginButtonRegistration<PluginText>; visible: boolean; waiting: boolean };
  const buttons = new Map<string, Button>();
  const lifetime = new AbortController();

  const add = (workspaceId: string) => {
    if (lifetime.signal.aborted || buttons.has(workspaceId)) return;
    const registration = client.addHeaderButton({
      id: "open-playbooks",
      workspaceId,
      button: {
        title: messages.message("title"),
        icon: "Workflow",
        visible: false,
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("playbooks", { workspaceId, location: "explorer" });
          },
        },
      },
    });
    buttons.set(workspaceId, { registration, visible: false, waiting: false });
    unknown.add(workspaceId);
  };
  const drop = (workspaceId: string) => {
    buttons.get(workspaceId)?.registration.remove();
    buttons.delete(workspaceId);
  };

  /** Workspaces whose state is not known yet: the next request asks about these only. */
  const unknown = new Set<string>();
  let inFlight = false;
  let again = false;
  let refreshAll = false;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  const apply = (queried: Map<string, Button>, state: { withPlaybooks: string[]; waiting: string[] }) => {
    const withPlaybooks = new Set(state.withPlaybooks);
    const waiting = new Set(state.waiting);
    for (const [workspaceId, button] of queried) {
      // A workspace removed and added again meanwhile is a new button: this answer is about the old one.
      if (buttons.get(workspaceId) !== button) continue;
      const visible = withPlaybooks.has(workspaceId);
      const isWaiting = waiting.has(workspaceId);
      if (visible === button.visible && isWaiting === button.waiting) continue;
      button.registration.update({ visible, icon: isWaiting ? WaitingIcon : "Workflow", title: isWaiting ? messages.message("headerWaiting") : messages.message("title") });
      button.visible = visible;
      button.waiting = isWaiting;
    }
  };

  /** One request at a time: asks about every workspace when `refreshAll`, else only the unknown ones. */
  const flush = async () => {
    if (lifetime.signal.aborted || buttons.size === 0) return;
    // A background tab keeps what it wants to know and asks when it shows again.
    if (isHidden()) return;
    if (inFlight) {
      again = true;
      return;
    }
    const ids = refreshAll ? [...buttons.keys()] : [...unknown].filter((id) => buttons.has(id));
    refreshAll = false;
    unknown.clear();
    if (ids.length === 0) return;
    const queried = new Map(ids.map((id) => [id, buttons.get(id)!] as const));
    inFlight = true;
    try {
      apply(queried, await client.rpc(headerStateRpc, { workspaceIds: ids }));
    } catch (error) {
      if (!lifetime.signal.aborted) console.error("[playbooks] header state failed", error);
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        void flush();
      }
    }
  };

  /** Sends one request after the burst of workspace events settles: all workspaces with `all`, else the unknown ones. */
  const refresh = (all: boolean) => {
    if (all) refreshAll = true;
    else if (unknown.size === 0) return;
    if (batchTimer !== null) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      void flush();
    }, NEW_WORKSPACES_BATCH_MS);
  };

  // An owned list subscription delivers existing workspaces, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return void subscription.release();
      const stop = subscription.subscribe({
        snapshot: ({ entries }) => {
          const ids = new Set(entries.map((workspace) => workspace.id));
          for (const workspaceId of [...buttons.keys()]) if (!ids.has(workspaceId)) drop(workspaceId);
          for (const id of ids) add(id);
          // A reconnect's snapshot lists workspaces already known: only the new ones need a request.
          refresh(false);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            // An upsert of a known workspace (a git or agent change) leaves what the button shows to the poll.
            add(update.workspace.id);
            refresh(false);
          } else {
            drop(update.id);
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
      if (!lifetime.signal.aborted) console.error("[playbooks] workspace observation failed", error);
    });

  // The poll keeps the waiting dots fresh; a background tab skips it and catches up when it shows again.
  const timer = setInterval(() => {
    if (!isHidden()) refresh(true);
  }, POLL_MS);
  const stopVisible = onVisible(() => refresh(true));
  return () => {
    lifetime.abort();
    clearInterval(timer);
    stopVisible();
    if (batchTimer !== null) clearTimeout(batchTimer);
    for (const workspaceId of [...buttons.keys()]) drop(workspaceId);
  };
}
