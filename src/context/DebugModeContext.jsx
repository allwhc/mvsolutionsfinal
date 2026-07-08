import { createContext, useContext, useState } from "react";

// Session-only "show raw sensor state" toggle. Off by default on every
// page load — deliberately NOT persisted, so a customer who accidentally
// stumbles on the toggle can just refresh the page to clear it.
//
// Wired from Dashboard header. Consumed by SensorCard / TankViz / analytics
// charts. When true, UI shows the raw firmware bits + non-consecutive fault
// pattern (purple ERR, red gap dots). When false, UI shows the highest wet
// probe as the level with all lower probes filled in as wet — the customer
// sees a clean physically-consistent reading.
const DebugModeContext = createContext({ debugMode: false, setDebugMode: () => {} });

export function DebugModeProvider({ children }) {
  const [debugMode, setDebugMode] = useState(false);
  return (
    <DebugModeContext.Provider value={{ debugMode, setDebugMode }}>
      {children}
    </DebugModeContext.Provider>
  );
}

export function useDebugMode() {
  return useContext(DebugModeContext);
}
