import "server-only";
import type { Run } from "@/lib/spec";
import { runQueue } from "@/server/run-queue";
import { getRun, listRuns } from "@/server/store";

/**
 * Run records on disk are written when a run changes status, not on every file, so an active run's
 * counts there stay at 0 until it ends. The queue holds the live copy; prefer it while a run is active.
 */
export async function listRunsLive(): Promise<Run[]> {
  const [runs] = await Promise.all([listRuns(), runQueue.whenReady()]);
  const live = new Map(runQueue.list().map((run) => [run.id, run]));
  return runs.map((run) => live.get(run.id) ?? run);
}

export async function getRunLive(id: string): Promise<Run | undefined> {
  await runQueue.whenReady();
  return runQueue.get(id) ?? (await getRun(id));
}
