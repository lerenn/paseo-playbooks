import { useTranslation, type PluginClientContext, type PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { messages } from "./i18n";
import { createBadgeStore, useWorkspaceBadges, type BadgeStore } from "./workspace-badges-store";
import type { OverviewStore } from "./overview-store";

/** The Playbooks icon (the sidebar item's and the panel's). */
const ICON = "Workflow";

/** Words that stay on the row for a state, instead of the step count. */
const WORDS = new Set(["held", "paused", "done", "failed", "canceled"]);

function RunBadgeItem(props: PluginWorkspaceRowBadgeItemProps & { store: BadgeStore }) {
  const { t } = useTranslation(messages);
  const badges = useWorkspaceBadges(props.store, props.workspaceId);
  if (!badges) return null;
  const { run } = badges;
  return (
    <WorkspaceRowBadge
      icon={ICON}
      tone={run.tone}
      label={WORDS.has(run.state) ? t(`shell.badge.state.${run.state as "held"}`) : t("shell.badge.steps", { done: run.done, total: run.total })}
      accessibilityLabel={t("shell.badge.runLabel", { playbook: run.playbook, state: t(`shell.badge.stateFull.${run.state}`), done: run.done, total: run.total })}
    />
  );
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

/** Both badges read one shared store: the host mounts them once per workspace row. */
export function contributeWorkspaceBadges(client: PluginClientContext, overview: OverviewStore) {
  const store = createBadgeStore(overview);
  const run = client.addWorkspaceRowBadgeItem({ id: "playbook-run", title: messages.message("shell.badge.runTitle"), icon: ICON, Component: (props) => <RunBadgeItem {...props} store={store} /> });
  const attention = client.addWorkspaceRowBadgeItem({ id: "playbook-attention", title: messages.message("shell.badge.attentionTitle"), icon: "TriangleAlert", Component: (props) => <AttentionBadgeItem {...props} store={store} /> });
  return () => {
    run();
    attention();
  };
}
