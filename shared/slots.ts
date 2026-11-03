/**
 * `concurrency` on a sub-playbook: its slots are shared by every run of the project, and a
 * run holds one from the moment its block is admitted until all the block's steps complete.
 */
import type { Playbook, Run } from "./types";
import { isStepDone, isTerminal } from "./types";

/** Ids of the steps inside a block (nested blocks included). */
export function blockStepIds(playbook: Playbook, prefix: string): string[] {
  return playbook.steps.filter((step) => step.id.startsWith(`${prefix}.`)).map((step) => step.id);
}

/** The block's first steps: those that need nothing from inside the block. */
export function blockEntrySteps(playbook: Playbook, prefix: string): string[] {
  const inside = new Set(blockStepIds(playbook, prefix));
  return playbook.steps.filter((step) => inside.has(step.id) && step.needs.every((need) => !inside.has(need))).map((step) => step.id);
}

/** The innermost block a step belongs to ("release.deploy" before "release"), or null at top level. */
export function innermostBlock(playbook: Playbook, stepId: string): string | null {
  let found: string | null = null;
  for (const prefix of Object.keys(playbook.blocks)) {
    if (stepId.startsWith(`${prefix}.`) && (found === null || prefix.length > found.length)) found = prefix;
  }
  return found;
}

/** Held once any step moved past pending/queued and the block is not finished (all steps completed or skipped). */
export function holdsBlock(run: Run, prefix: string): boolean {
  if (isTerminal(run.status)) return false;
  const states = blockStepIds(run.playbook, prefix).map((id) => run.steps[id]!.status);
  if (states.every(isStepDone)) return false;
  return states.some((status) => status !== "pending" && status !== "queued");
}

/** Slots of `playbookId` in use in the project: active top-level runs of it, plus blocks of it held by other runs. */
export function slotHolders(runs: Run[], projectId: string, playbookId: string): string[] {
  const holders: string[] = [];
  for (const run of runs) {
    if (run.projectId !== projectId || isTerminal(run.status)) continue;
    if (run.playbook.id === playbookId) holders.push(run.id);
    for (const [prefix, block] of Object.entries(run.playbook.blocks)) {
      if (block.playbook === playbookId && holdsBlock(run, prefix)) holders.push(`${run.id}:${prefix}`);
    }
  }
  return holders;
}

export interface Admission {
  runId: string;
  prefix: string;
}

/** Which queued blocks may enter now, oldest first, while slots are free. */
export function planAdmissions(runs: Run[]): Admission[] {
  const waiting: Array<Admission & { projectId: string; playbookId: string; limit: number; since: string }> = [];
  for (const run of runs) {
    if (isTerminal(run.status)) continue;
    for (const [prefix, block] of Object.entries(run.playbook.blocks)) {
      if (block.concurrency === undefined) continue;
      const queued = blockStepIds(run.playbook, prefix).map((id) => run.steps[id]!).filter((state) => state.status === "queued");
      if (queued.length === 0) continue;
      const since = queued.map((state) => state.queuedAt ?? run.createdAt).sort()[0]!;
      waiting.push({ runId: run.id, prefix, projectId: run.projectId, playbookId: block.playbook, limit: block.concurrency, since });
    }
  }
  waiting.sort((a, b) => a.since.localeCompare(b.since) || a.runId.localeCompare(b.runId));
  const used = new Map<string, number>();
  const admitted: Admission[] = [];
  for (const item of waiting) {
    const key = `${item.projectId}|${item.playbookId}`;
    const count = used.get(key) ?? slotHolders(runs, item.projectId, item.playbookId).length;
    if (count >= item.limit) {
      used.set(key, count);
      continue;
    }
    used.set(key, count + 1);
    admitted.push({ runId: item.runId, prefix: item.prefix });
  }
  return admitted;
}
