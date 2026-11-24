/**
 * Whether the host draws at least one of its own meta items before our badges on a workspace row, so
 * that our leading "·" has something to separate from. Mirrors the host's `selectMetaRowItems`
 * (Paseo 0.17 web UI), which pushes, in this order and each only when it applies: branch, project,
 * host badge, pull request, checks, running services, labels.
 */
export interface HostMetaInput {
  /** The workspace's branch (the host's `currentBranch`). */
  branch?: string | null;
  /** The project's name; the host shows it only on rows listed outside their project's group. */
  projectName?: string | null;
  /** Labels on the workspace. */
  labels?: readonly unknown[];
  /** The host's badge: drawn only when several hosts are connected. */
  hasHostBadge?: boolean;
  /** A pull request is linked to the workspace; it also gives the checks item unless checks are hidden. */
  hasPullRequest?: boolean;
  /** A running script service on the workspace (never drawn on touch or compact layouts). */
  hasService?: boolean;
}

/** The Show menu's per-item toggles. */
export interface HostMetaVisibility {
  branch: boolean;
  project: boolean;
  changeRequest: boolean;
  /** The checks item: shown unless the setting is "none". */
  checks: boolean;
  services: boolean;
  labels: boolean;
}

/** The host's defaults (`DEFAULT_SIDEBAR_ROW_ITEMS`, checks "iconAndText"). */
export const DEFAULT_HOST_META_VISIBILITY: HostMetaVisibility = {
  branch: false,
  project: false,
  changeRequest: true,
  checks: true,
  services: true,
  labels: true,
};

/**
 * Whether the host draws its badge (the host name or icon) on the workspace rows. The host does it when
 * the Show menu's host item is on (default on) AND the sidebar lists workspaces of at least two hosts
 * (`shouldShowSidebarHostLabels`: two distinct server ids) AND the row's host is not hidden: by default
 * the local host is hidden and the others show their name, unless the user set a badge display for that
 * host. The plugin reads the configured hosts (`useHosts`) but neither which one is local, nor a host's
 * badge setting, nor the Show menu: so it counts the hosts that are online and assumes the default.
 */
export function hostBadgeLikelyDrawn(hosts: readonly { status: string }[]): boolean {
  return hosts.filter((host) => host.status === "online").length >= 2;
}

/**
 * The dot shows when something is drawn before our badges. Detected: labels and the host badge (likely,
 * see `hostBadgeLikelyDrawn`). A pull request, checks, services, and a branch or project the user turned
 * on cannot be read: with several hosts the host badge is there anyway, with one host they are missed.
 */
export function hasLeadingHostItem(input: HostMetaInput, visible: HostMetaVisibility = DEFAULT_HOST_META_VISIBILITY): boolean {
  return Boolean(
    (input.branch && visible.branch) ||
      (input.projectName && visible.project) ||
      input.hasHostBadge ||
      (input.hasPullRequest && (visible.changeRequest || visible.checks)) ||
      (input.hasService && visible.services) ||
      ((input.labels?.length ?? 0) > 0 && visible.labels),
  );
}
