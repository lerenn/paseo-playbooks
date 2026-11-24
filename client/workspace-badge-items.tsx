import { useTranslation, useWorkspace, type PluginClientContext, type PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { Icon, WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { messages } from "./i18n";
import { hasLeadingHostItem } from "./host-meta";
import { createBadgeStore, useLeadingDot, useWorkspaceBadges, type BadgeStore } from "./workspace-badges-store";
import type { OverviewStore } from "./overview-store";
import { semanticColor, type SemanticTone } from "./semantic-colors";
import type { Theme } from "./theme";
import type { BadgeTone } from "./workspace-badges";

/** The Playbooks icon (the sidebar item's and the panel's). */
const ICON = "Workflow";

/**
 * A badge drawn by the plugin with the host badge's layout and values (read in Paseo 0.17's web UI):
 * a row, the icon and the label 3 apart, shrinking and ellipsized rather than wrapping, icon 12, text
 * 12/16. Used where the host's badge cannot: for violet, which the host has no tone for, and for the
 * leading "·", which the host draws between its own meta items but not before a plugin's. A row with a
 * semantic state (`rowTone`) draws every badge (icon and text) in that state's fixed colour; without one the
 * badge's tone uses the theme's colours. The dot is always the muted grey, like the host's own separators.
 */
function PluginBadge(props: { theme: Theme; tone: BadgeTone; rowTone: SemanticTone | null; icon: string; label: string; accessibilityLabel: string; dot: boolean }) {
  const { theme, tone } = props;
  const color =
    props.rowTone ? semanticColor(theme, props.rowTone)
    : tone === "violet" ? semanticColor(theme, "paused")
    : tone === "success" ? theme.colors.statusSuccess
    : tone === "warning" ? theme.colors.statusWarning
    : tone === "danger" ? theme.colors.statusDanger
    : tone === "info" ? semanticColor(theme, "running")
    : theme.colors.foregroundMuted;
  const badge = (
    <View accessible accessibilityLabel={props.accessibilityLabel} style={{ flexDirection: "row", alignItems: "center", gap: 3, minWidth: 0, flexShrink: 1 }}>
      <Icon name={props.icon} size={12} color={color} />
      <Text numberOfLines={1} style={{ color, fontSize: 12, lineHeight: 16, minWidth: 0, flexShrink: 1 }}>
        {props.label}
      </Text>
    </View>
  );
  if (!props.dot) return badge;
  // The host's separator is its extra-muted foreground, which the plugin theme lacks: the muted one, dimmed. It never shrinks, the label does.
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1 }}>
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: theme.colors.foregroundMuted, opacity: 0.7, fontSize: 12, lineHeight: 16, flexShrink: 0 }}>
        {"\u00b7"}
      </Text>
      {badge}
    </View>
  );
}

/** The host's badge when nothing needs a custom render (no row colour, no violet, no leading dot), else the plugin's own. */
function Badge(props: { theme: Theme; tone: BadgeTone; rowTone: SemanticTone | null; icon: string; label: string; accessibilityLabel: string; dot: boolean }) {
  if (props.rowTone || props.tone === "violet" || props.dot) return <PluginBadge {...props} />;
  return <WorkspaceRowBadge icon={props.icon} tone={props.tone} label={props.label} accessibilityLabel={props.accessibilityLabel} />;
}

/**
 * Whether the host draws a meta item of its own before our badges on this row. The plugin reads the
 * workspace's labels, not the Show menu (so the defaults apply: branch and project hidden) nor the pull
 * request, checks, services or host badge (not exposed). Where unsure the answer is no: a missing dot
 * looks better than a lone one.
 */
function useHostItemBefore(workspaceId: string): boolean {
  return useWorkspace(workspaceId, (workspace) => hasLeadingHostItem({ labels: workspace.labels })) ?? false;
}

function RunBadgeItem(props: PluginWorkspaceRowBadgeItemProps & { store: BadgeStore }) {
  const { t } = useTranslation(messages);
  const badges = useWorkspaceBadges(props.store, props.workspaceId);
  const hostItem = useHostItemBefore(props.workspaceId);
  const dot = useLeadingDot(props.store, props.workspaceId, "playbook-run", badges !== null) && hostItem;
  if (!badges) return null;
  const { run, rowTone } = badges;
  const label = run.live ? t("shell.badge.steps", { done: run.done, total: run.total }) : t(`shell.badge.state.${run.state as "done"}`);
  const accessibilityLabel = t("shell.badge.runLabel", { playbook: run.playbook, state: t(`shell.badge.stateFull.${run.state}`), done: run.done, total: run.total });
  return <Badge theme={props.theme} tone={run.tone} rowTone={rowTone} icon={ICON} label={label} accessibilityLabel={accessibilityLabel} dot={dot} />;
}

/** The state of a live run: an icon and a word, violet when paused. */
function StateBadgeItem(props: PluginWorkspaceRowBadgeItemProps & { store: BadgeStore }) {
  const { t } = useTranslation(messages);
  const badges = useWorkspaceBadges(props.store, props.workspaceId);
  const state = badges?.state ?? null;
  const hostItem = useHostItemBefore(props.workspaceId);
  const dot = useLeadingDot(props.store, props.workspaceId, "playbook-state", state !== null) && hostItem;
  if (!badges || !state) return null;
  const label = t(`shell.badge.stateWord.${state.kind}`);
  const accessibilityLabel = t("shell.badge.runLabel", { playbook: badges.run.playbook, state: t(`shell.badge.stateFull.${badges.run.state}`), done: badges.run.done, total: badges.run.total });
  return <Badge theme={props.theme} tone={state.tone} rowTone={badges.rowTone} icon={state.icon} label={label} accessibilityLabel={accessibilityLabel} dot={dot} />;
}

function AttentionBadgeItem(props: PluginWorkspaceRowBadgeItemProps & { store: BadgeStore }) {
  const { t } = useTranslation(messages);
  const badges = useWorkspaceBadges(props.store, props.workspaceId);
  const attention = badges?.attention ?? null;
  const hostItem = useHostItemBefore(props.workspaceId);
  const dot = useLeadingDot(props.store, props.workspaceId, "playbook-attention", attention !== null) && hostItem;
  if (!attention) return null;
  return (
    <Badge
      theme={props.theme}
      tone={attention.tone}
      rowTone={badges?.rowTone ?? null}
      icon="TriangleAlert"
      label={t(`shell.badge.attention.${attention.kind}`)}
      accessibilityLabel={t("shell.badge.attentionLabel", { reason: t(`shell.badge.attentionFull.${attention.kind}`) })}
      dot={dot}
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
