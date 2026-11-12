import "server-only";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PART_FILE } from "@/server/runner";

/**
 * The key both sides agree on: a `.part` file is the final file name plus ".part", whether it sits beside the
 * final file or in a worker's own part folder. Case-folded on Windows, where the names compare that way.
 */
export function partKey(path: string): string {
  const name = basename(path);
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export interface PartSink {
  /** An unfinished file that was already there when its folder started being watched. */
  seed(key: string, size: number): void;
  grow(key: string, size: number): void;
}

interface WatchedDir {
  /** `.part` names seen in the folder and not yet gone. */
  names: Set<string>;
  watcher?: FSWatcher;
  ready: boolean;
}

/**
 * Follows the `*.part` files of a step's folders. gallery-dl prints a file only after it is saved, so these sizes
 * are the only sign of progress while a large video downloads. A folder can be the account's whole media folder
 * with tens of thousands of files, so it is listed once; after that the file system reports new `.part` names
 * and each poll reads only those.
 */
export class PartWatcher {
  private readonly dirs = new Map<string, WatchedDir>();
  private closed = false;

  constructor(private readonly sink: PartSink) {}

  /** Starts following `dir`. What is already in it was not downloaded by this step, so it is only seeded. */
  async watch(dir: string): Promise<void> {
    if (this.closed || this.dirs.has(dir)) return;
    const state: WatchedDir = { names: new Set(), ready: false };
    this.dirs.set(dir, state);
    await this.open(dir, state, true);
  }

  /** Reads the sizes of the known `.part` files. A folder that did not exist yet is tried again here. */
  async poll(): Promise<void> {
    await Promise.all(
      [...this.dirs].map(async ([dir, state]) => {
        // Created after watching began, so anything in it now belongs to this step.
        if (!state.watcher) await this.open(dir, state, false);
        if (!state.ready || this.closed) return;
        for (const [key, size] of await this.read(dir, state)) this.sink.grow(key, size);
      }),
    );
  }

  close(): void {
    this.closed = true;
    for (const state of this.dirs.values()) state.watcher?.close();
    this.dirs.clear();
  }

  private async open(dir: string, state: WatchedDir, seedExisting: boolean): Promise<void> {
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (name && PART_FILE.test(String(name))) state.names.add(String(name));
      });
    } catch {
      return;
    }
    watcher.on("error", () => {
      // The folder was removed (a worker's part folder after its step); a later poll opens it again if it returns.
      watcher.close();
      state.watcher = undefined;
      state.ready = false;
    });
    state.watcher = watcher;
    // Listed after the watch started, so a file created in between is not missed.
    try {
      for (const name of await readdir(dir)) {
        if (PART_FILE.test(name)) state.names.add(name);
      }
    } catch {
      /* removed meanwhile; the error handler above resets it */
    }
    if (seedExisting) {
      for (const [key, size] of await this.read(dir, state)) this.sink.seed(key, size);
    }
    state.ready = true;
    if (this.closed) watcher.close();
  }

  private async read(dir: string, state: WatchedDir): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    await Promise.all(
      [...state.names].map(async (name) => {
        try {
          const info = await stat(join(dir, name));
          if (!info.isFile()) return;
          // Fragments of one download ("x.mp4.part-Frag3") add up to one file.
          const key = partKey(name.replace(PART_FILE, ""));
          sizes.set(key, (sizes.get(key) ?? 0) + info.size);
        } catch {
          // Finished (renamed) or removed.
          state.names.delete(name);
        }
      }),
    );
    return sizes;
  }
}
