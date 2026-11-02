import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { headerStateRpc } from "../shared/contracts";

const TITLE = "Playbooks";
const WAITING_TITLE = "Playbooks: a run is waiting for your decision";
/** How often the buttons refresh which workspaces have playbooks or a waiting gate. */
const POLL_MS = 10_000;

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
          backgroundColor: props.theme.colors.statusWarning,
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
  const buttons = new Map<string, { registration: PluginButtonRegistration; visible: boolean; waiting: boolean }>();
  const lifetime = new AbortController();

  const add = (workspaceId: string) => {
    if (lifetime.signal.aborted || buttons.has(workspaceId)) return;
    const registration = client.addHeaderButton({
      id: "open-playbooks",
      workspaceId,
      button: {
        title: TITLE,
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
  };
  const drop = (workspaceId: string) => {
    buttons.get(workspaceId)?.registration.remove();
    buttons.delete(workspaceId);
  };

  const refresh = async () => {
    if (lifetime.signal.aborted || buttons.size === 0) return;
    try {
      const state = await client.rpc(headerStateRpc, { workspaceIds: [...buttons.keys()] });
      const withPlaybooks = new Set(state.withPlaybooks);
      const waiting = new Set(state.waiting);
      for (const [workspaceId, button] of buttons) {
        const visible = withPlaybooks.has(workspaceId);
        const isWaiting = waiting.has(workspaceId);
        if (visible === button.visible && isWaiting === button.waiting) continue;
        button.registration.update({ visible, icon: isWaiting ? WaitingIcon : "Workflow", title: isWaiting ? WAITING_TITLE : TITLE });
        button.visible = visible;
        button.waiting = isWaiting;
      }
    } catch (error) {
      if (!lifetime.signal.aborted) console.error("[playbooks] header state failed", error);
    }
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
          void refresh();
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            add(update.workspace.id);
            void refresh();
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

  const timer = setInterval(() => void refresh(), POLL_MS);
  return () => {
    lifetime.abort();
    clearInterval(timer);
    for (const workspaceId of [...buttons.keys()]) drop(workspaceId);
  };
}
