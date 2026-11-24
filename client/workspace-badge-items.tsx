import { useTranslation, type PluginClientContext, type PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { Icon, WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { messages } from "./i18n";
import { createBadgeStore, useWorkspaceBadges, type BadgeStore } from "./workspace-badges-store";
import type { OverviewStore } from "./overview-store";
import { semanticColor } from "./semantic-colors";
import type { Theme } from "./theme";

/** The Playbooks icon (the sidebar item's and the panel's). */
const ICON = "Workflow";

/**
 * The host's badge has no violet tone, so the paused state badge draws its own with the host badge's layout
 * (a row, the icon and the label 3 apart, shrinking and ellipsized rather than wrapping) in the fixed
 * paused violet. The icon size (12) is a guess at the host's: the typings do not give it.
 */
function VioletBadge(props: { theme: Theme; icon: string; label: string; accessibilityLabel: string }) {
  const color = semanticColor(props.theme, "paused");
  return (
    <View accessible accessibilityLabel={props.accessibilityLabel} style={{ flexDirection: "row", alignItems: "center", gap: 3, minWidth: 0, flexShrink: 1 }}>
      <Icon name={props.icon} size={12} color={color} />
      <Text numberOfLines={1} style={{ color, fontSize: 12, lineHeight: 16, minWidth: 0, flexShrink: 1 }}>
        {props.label}
      </Text>
    </View>
  );
}

function RunBadgeItem(props: PluginWorkspaceRowBadgeItemProps & { store: BadgeStore }) {
  const { t } = useTranslation(messages);
  const badges = useWorkspaceBadges(props.store, props.workspaceId);
  if (!badges) return null;
  const { run } = badges;
  const label = run.live ? t("shell.badge.steps", { done: run.done, total: run.total }) : t(`shell.badge.state.${run.state as "done"}`);
  const accessibilityLabel = t("shell.badge.runLabel", { playbook: run.playbook, state: t(`shell.badge.stateFull.${run.state}`), done: run.done, total: run.total });
  return <WorkspaceRowBadge icon={ICON} tone={run.tone} label={label} accessibilityLabel={accessibilityLabel} />;
}

/** The state of a live run: an icon and a word, violet (drawn here) when paused. */
function StateBadgeItem(props: PluginWorkspaceRowBadgeItemProps & { store: BadgeStore }) {
  const { t } = useTranslation(messages);
  const badges = useWorkspaceBadges(props.store, props.workspaceId);
  const state = badges?.state;
  if (!badges || !state) return null;
  const label = t(`shell.badge.stateWord.${state.kind}`);
  const accessibilityLabel = t("shell.badge.runLabel", { playbook: badges.run.playbook, state: t(`shell.badge.stateFull.${badges.run.state}`), done: badges.run.done, total: badges.run.total });
  if (state.tone === "violet") return <VioletBadge theme={props.theme} icon={state.icon} label={label} accessibilityLabel={accessibilityLabel} />;
  return <WorkspaceRowBadge icon={state.icon} tone={state.tone} label={label} accessibilityLabel={accessibilityLabel} />;
}

function AttentionBadgeItem(props: PluginWorkspaceRowBadgeItemProps & { store: BadgeStore }) {
  const { t } = useTranslation(messages);
  const attention = useWorkspaceBadges(props.store, props.workspaceId)?.attention;
  if (!attention) return null;
  return (
    <WorkspaceRowBadge
      icon="TriangleAlert"
      tone={attention.tone}
      label={t(`shell.badge.attention.${attention.kind}`)}
      accessibilityLabel={t("shell.badge.attentionLabel", { reason: t(`shell.badge.attentionFull.${attention.kind}`) })}
    />
  );
}

/** The three badges read one shared store: the host mounts them once per workspace row. */
export function contributeWorkspaceBadges(client: PluginClientContext, overview: OverviewStore) {
  const store = createBadgeStore(overview);
  const run = client.addWorkspaceRowBadgeItem({ id: "playbook-run", title: messages.message("shell.badge.runTitle"), icon: ICON, Component: (props) => <RunBadgeItem {...props} store={store} /> });
  const state = client.addWorkspaceRowBadgeItem({ id: "playbook-state", title: messages.message("shell.badge.stateTitle"), icon: "Play", Component: (props) => <StateBadgeItem {...props} store={store} /> });
  const attention = client.addWorkspaceRowBadgeItem({ id: "playbook-attention", title: messages.message("shell.badge.attentionTitle"), icon: "TriangleAlert", Component: (props) => <AttentionBadgeItem {...props} store={store} /> });
  return () => {
    run();
    state();
    attention();
  };
}
