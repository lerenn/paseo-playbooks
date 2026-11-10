import type { SidekickProject } from "../../shared/contracts";

/**
 * The projects that get a tab: those with active runs or an already-created Sidekick, and those the user
 * added with "+" this session. Most active first, then by label.
 */
export function visibleTabs(projects: SidekickProject[], added: string[]): SidekickProject[] {
  return projects
    .filter((project) => project.activeRuns > 0 || project.agentId !== null || added.includes(project.projectId))
    .sort((a, b) => b.activeRuns - a.activeRuns || a.label.localeCompare(b.label));
}

/** The one-line status under the tabs: "2 need you · 1 working", or null when there is nothing to say. */
export function statusLine(project: Pick<SidekickProject, "activeRuns" | "needYou">): string | null {
  const parts = [project.needYou > 0 ? `${project.needYou} need you` : null, project.activeRuns > 0 ? `${project.activeRuns} working` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
