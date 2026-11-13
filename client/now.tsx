import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** One clock for a whole view: every running step reads it, so there is one interval, not one per card. */
const NowContext = createContext<number>(Date.now());

const NOW_TICK_MS = 1_000;

/** Ticks every second while `active`; the interval is cleared when it stops being active or unmounts. */
export function NowProvider(props: { active: boolean; children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!props.active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [props.active]);
  return <NowContext.Provider value={now}>{props.children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}
