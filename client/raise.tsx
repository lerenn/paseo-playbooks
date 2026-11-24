import { createContext, useContext, useState, type ReactNode } from "react";
import { View } from "react-native";

/**
 * A `zIndex` only orders siblings inside one stacking context, so a popover opened in a row is still painted under the rows after it.
 * A `Raised` wrapper lifts itself (and, through its parents, every `Raised` around it) above its siblings while a popover inside is open.
 */
const RaiseContext = createContext<(open: boolean) => void>(() => undefined);

/** The function a popover calls with whether it is open. */
export function useRaise(): (open: boolean) => void {
  return useContext(RaiseContext);
}

/** The z-index a wrapper takes while something inside it is open. */
export const RAISED = 100;

export function Raised(props: { children: ReactNode; style?: object }) {
  const parent = useRaise();
  const [raised, setRaised] = useState(false);
  const set = (open: boolean) => {
    setRaised(open);
    parent(open);
  };
  return (
    <RaiseContext.Provider value={set}>
      <View style={[props.style, raised ? { zIndex: RAISED } : null]}>{props.children}</View>
    </RaiseContext.Provider>
  );
}
