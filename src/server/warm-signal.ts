import "server-only";
import { EventEmitter } from "node:events";

/** Tells the thumbnail warmer that an account folder got new files. Nothing listens in tests. */
export const folderChanges = new EventEmitter();

export function folderChanged(dir: string): void {
  folderChanges.emit("changed", dir);
}
