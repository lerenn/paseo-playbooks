import type { Run } from "../shared/types";
import { slowSteps, slowView, type SlowInfo, type SlowRunView } from "../shared/slow";

/**
 * The slow-step warning for agents (ADR 2026-11-12-slow-steps-in-tools): the rules are shared/slow.ts's, the
 * history is every run the server holds (archived ones too), grouped by playbook once per index.
 */
export class SlowIndex {
  private readonly views = new Map<string, SlowRunView[]>();

  constructor(runs: readonly Run[]) {
    for (const run of runs) {
      const view = slowView(run);
      const list = this.views.get(view.playbook.id);
      if (list) list.push(view);
      else this.views.set(view.playbook.id, [view]);
    }
  }

  /** The slow steps of a run, by step id. */
  of(run: Run, now = Date.now()): Record<string, SlowInfo> {
    return slowSteps(slowView(run), this.views.get(run.playbook.id) ?? [], now);
  }
}

/** A slow step as a tool shows it. `running`: it has not ended, so it is slow right now. */
export function slowEntry(run: Run, stepId: string, info: SlowInfo) {
  return {
    elapsedMs: info.elapsedMs,
    baselineMs: Math.round(info.baselineMs),
    factor: run.playbook.slowWarning.factor,
    ratio: Math.round(info.ratio * 10) / 10,
    samples: info.samples,
    running: run.steps[stepId]?.status === "running",
  };
}

/** Per slow step, its tool entry. */
export function slowEntries(run: Run, slow: Record<string, SlowInfo>) {
  return Object.fromEntries(Object.entries(slow).map(([id, info]) => [id, slowEntry(run, id, info)]));
}
