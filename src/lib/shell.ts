"use client";

import { useEffect, useState } from "react";

/** What the Electron preload exposes. Absent when the app runs in a normal browser. */
export interface GatherShell {
  pickFolder(defaultPath?: string): Promise<string | null>;
  openLogs(): Promise<void>;
}

declare global {
  interface Window {
    gatherShell?: GatherShell;
  }
}

/** Read after mount so the server render and the first client render agree. */
export function useShell(): GatherShell | undefined {
  const [shell, setShell] = useState<GatherShell | undefined>(undefined);
  useEffect(() => setShell(window.gatherShell), []);
  return shell;
}
