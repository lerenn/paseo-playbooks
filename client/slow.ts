import { useEffect, useRef, useState } from "react";
import { keepSlow, slowSteps, type SlowInfo, type SlowRunView } from "../shared/slow";

/** How often a running step is measured again against its baseline. */
const SLOW_TICK_MS = 30_000;

const NONE: Record<string, SlowInfo> = {};

/**
 * The slow steps of a run, live. A warning that was shown stays while the component shows this run
 * (append-only: a step that finishes faster than the one that raised it does not clear it).
 */
export function useSlowSteps(run: SlowRunView | null, history: readonly SlowRunView[]): Record<string, SlowInfo> {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), SLOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const shown = useRef<{ runId: string; slow: Record<string, SlowInfo> }>({ runId: "", slow: NONE });
  if (!run) return NONE;
  if (shown.current.runId !== run.id) shown.current = { runId: run.id, slow: NONE };
  shown.current.slow = keepSlow(shown.current.slow, slowSteps(run, history, Date.now()));
  return shown.current.slow;
}
