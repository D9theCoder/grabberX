"use client";

import { useEffect, useState } from "react";

/** The desktop updater, as the shell reports it. */
export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "current"; checkedAt: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string; checkedAt: string }
  | { state: "unavailable" };

/** What the Electron preload exposes. Absent when the app runs in a normal browser. */
export interface GatherShell {
  pickFolder(defaultPath?: string): Promise<string | null>;
  openLogs(): Promise<void>;
  /** Moves one media file to the Recycle Bin. False when the shell refused or the move failed. */
  trashItem(path: string): Promise<boolean>;
  /** Opens Explorer with the file selected. Older desktop builds lack it. */
  showItem?(path: string): Promise<boolean>;
  /** Opens the file in its default Windows app. */
  openItem?(path: string): Promise<boolean>;
  /** Keeps the window background in step with the page theme. */
  setTheme?(theme: "light" | "dark"): Promise<void>;
  getUpdateState?(): Promise<UpdateState | null>;
  /** Starts a check unless one is already running or an update is downloading or waiting. */
  checkForUpdate?(): Promise<UpdateState | null>;
  /** Quits and installs a downloaded update; false when the user kept their runs going. */
  installUpdate?(): Promise<boolean>;
  /** Returns the function that stops listening. */
  onUpdateState?(listener: (state: UpdateState) => void): () => void;
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
