import type { ProcessHandle, ProcessResult } from "@/server/runner";

/** Workers start this far apart, so they do not all open the archive and fetch the first page at once. */
export const WORKER_STAGGER_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One result for the step: a spawn error wins, then the first failing exit code, else success. */
export function combineResults(results: ProcessResult[]): ProcessResult {
  const spawnError = results.find((result) => result.spawnError)?.spawnError;
  if (spawnError) return { exitCode: null, spawnError };
  const failed = results.find((result) => result.exitCode !== 0);
  return { exitCode: failed ? failed.exitCode : 0 };
}

/**
 * Starts the parallel workers of one step as a single handle: `done` settles when every worker has ended,
 * and `stop` stops the ones already started and keeps the rest from starting. A failing worker does not stop
 * the others; the files they save are good, and the step still reports the failure.
 */
export function startWorkers(
  starters: Array<() => ProcessHandle>,
  staggerMs: number = WORKER_STAGGER_MS,
  wait: (ms: number) => Promise<void> = delay,
): ProcessHandle {
  const handles: ProcessHandle[] = [];
  let stopped = false;

  const done = (async () => {
    const results: Promise<ProcessResult>[] = [];
    for (let index = 0; index < starters.length; index++) {
      if (index > 0) await wait(staggerMs);
      if (stopped) break;
      const handle = starters[index]!();
      handles.push(handle);
      results.push(handle.done);
    }
    return combineResults(await Promise.all(results));
  })();

  return {
    pid: undefined,
    done,
    async stop() {
      stopped = true;
      await Promise.all(handles.map((handle) => handle.stop()));
    },
  };
}
