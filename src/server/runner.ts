import "server-only";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { parseLine } from "@/lib/parse-line";
import type { RunEvent } from "@/lib/spec";

export interface StartProcessOptions {
  exe: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent: (event: RunEvent) => void;
  onRaw: (stream: "stdout" | "stderr", line: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  /** Set when the process could not be started at all, e.g. "ENOENT" for a missing exe. */
  spawnError?: string;
}

export interface ProcessHandle {
  pid: number | undefined;
  done: Promise<ProcessResult>;
  stop(): Promise<void>;
}

export type StartProcess = (options: StartProcessOptions) => ProcessHandle;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killTreeWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    // taskkill /T also kills the second process a PyInstaller one-file exe starts; child.kill()
    // would only kill the bootloader and leave the downloader holding the archive lock.
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => resolve());
    killer.on("close", () => resolve());
  });
}

export const startProcess: StartProcess = (options) => {
  let finished = false;
  let resolveDone: (result: ProcessResult) => void = () => {};
  const done = new Promise<ProcessResult>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (result: ProcessResult): void => {
    if (finished) return;
    finished = true;
    resolveDone(result);
  };

  let child: ChildProcess;
  try {
    child = spawn(options.exe, options.argv, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        ...options.env,
      },
    });
  } catch (error) {
    finish({ exitCode: null, spawnError: messageOf(error) });
    return { pid: undefined, done, stop: async () => {} };
  }

  child.on("error", (error: NodeJS.ErrnoException) => {
    finish({ exitCode: null, spawnError: error.code ?? error.message });
  });
  child.on("close", (code) => {
    finish({ exitCode: code });
  });

  const wire = (stream: "stdout" | "stderr"): void => {
    const source = stream === "stdout" ? child.stdout : child.stderr;
    if (!source) return;
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    lines.on("line", (line) => {
      options.onRaw(stream, line);
      const event = parseLine(stream, line);
      if (event) options.onEvent(event);
    });
  };
  wire("stdout");
  wire("stderr");

  const stop = async (): Promise<void> => {
    const pid = child.pid;
    if (!finished && pid !== undefined) {
      if (process.platform === "win32") {
        await killTreeWindows(pid);
      } else {
        // detached: true made the child a group leader, so the negative pid kills its children too.
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    }
    await Promise.race([done, delay(5000)]);
    // If the kill never reports back, resolve anyway so the queue cannot hang on a lost process.
    finish({ exitCode: null });
  };

  return { pid: child.pid, done, stop };
};

const PART_FILE = /\.part(-.*)?$/i;

/** Deletes gallery-dl's leftover `*.part` / `*.part-*` files recursively. Returns the count. */
export async function sweepPartFiles(dir: string): Promise<number> {
  if (!isAbsolute(dir)) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await sweepPartFiles(full);
      continue;
    }
    if (!entry.isFile() || !PART_FILE.test(entry.name)) continue;
    try {
      await unlink(full);
      removed += 1;
    } catch {
      /* already gone */
    }
  }
  return removed;
}
