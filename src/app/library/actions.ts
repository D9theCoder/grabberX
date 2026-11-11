"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult, LibraryEntry, Run, RunStatus, Settings } from "@/lib/spec";
import { activeSkipReason } from "@/lib/update-messages";
import { buildUpdateSpec, folderKey, runsForFolder } from "@/lib/update-spec";
import type { UpdateAccountData, UpdateAllResult, UpdatePlan, UpdateSkip } from "@/lib/update-spec";
import { listAccounts } from "@/server/library";
import { runQueue } from "@/server/run-queue";
import { getSettings, listRuns } from "@/server/store";

/** History retention caps runs at 2000, so one read for the whole update beats one read per folder. */
const ALL_RUNS = Number.MAX_SAFE_INTEGER;
/** Enough to hold the latest run of the accounts someone updates regularly. */
const RECENT_RUNS = 200;

interface UpdateContext {
  settings: Settings;
  accounts: LibraryEntry[];
  runs: Run[];
}

/** Folders with an enqueue in flight: the queue does not see a run until enqueue has created it. */
const enqueueing = new Set<string>();

type QueueOutcome =
  | { ok: true; runId: string }
  | { ok: false; active: RunStatus | null };

function alreadyActive(folder: string): string {
  return `An update for ${folder} is already queued or running.`;
}

async function loadContext(runLimit: number): Promise<UpdateContext> {
  const [settings, accounts, runs] = await Promise.all([
    getSettings(),
    listAccounts(),
    listRuns(runLimit),
  ]);
  return { settings, accounts, runs };
}

/** Claims the folder while enqueue awaits, so a double click cannot queue the same update twice. */
async function queueUpdate(folder: string, plan: UpdatePlan): Promise<QueueOutcome> {
  const key = folderKey(folder);
  const active = runQueue.findActive(folder);
  if (active || enqueueing.has(key)) {
    return { ok: false, active: active?.status ?? "queued" };
  }

  enqueueing.add(key);
  try {
    const run = await runQueue.enqueue(plan.spec);
    return { ok: true, runId: run.id };
  } catch (error) {
    console.error(`gather: could not queue the update for ${folder}.`, error);
    return { ok: false, active: null };
  } finally {
    enqueueing.delete(key);
  }
}

export async function updateAccount(folder: string): Promise<ActionResult<UpdateAccountData>> {
  if (typeof folder !== "string" || folder.trim() === "") {
    return { ok: false, error: "This account isn't in the library." };
  }
  // Cheap refusal before the scan: an active run means there is nothing to queue.
  if (runQueue.findActive(folder)) {
    return { ok: false, error: alreadyActive(folder) };
  }

  let context: UpdateContext;
  try {
    context = await loadContext(RECENT_RUNS);
  } catch (error) {
    console.error("gather: could not read the library.", error);
    return { ok: false, error: "The library couldn't be read." };
  }

  const entry = context.accounts.find((account) => folderKey(account.folder) === folderKey(folder));
  if (!entry) return { ok: false, error: "This account isn't in the library." };

  // One folder needs only its latest real run, which is almost always among the newest records. Read
  // the whole history only when it is not, e.g. an account last run long ago, or only previews since.
  if (!runsForFolder(entry.folder, context.runs).some((run) => !run.spec.simulate)) {
    try {
      context = { ...context, runs: await listRuns(ALL_RUNS) };
    } catch (error) {
      console.error("gather: could not read the run history.", error);
      return { ok: false, error: "The library couldn't be read." };
    }
  }

  const built = buildUpdateSpec(entry.folder, entry, context.runs, context.settings);
  if (!built.ok) return built;

  const queued = await queueUpdate(entry.folder, built.data);
  if (!queued.ok) {
    return {
      ok: false,
      error: queued.active ? alreadyActive(entry.folder) : "The update couldn't be started.",
    };
  }

  revalidatePath("/history");
  const assumedSite = built.data.assumedSite;
  return { ok: true, data: assumedSite ? { runId: queued.runId, assumedSite } : { runId: queued.runId } };
}

export async function updateAll(): Promise<ActionResult<UpdateAllResult>> {
  let context: UpdateContext;
  try {
    context = await loadContext(ALL_RUNS);
  } catch (error) {
    console.error("gather: could not read the library.", error);
    return { ok: false, error: "The library couldn't be read." };
  }

  let started = 0;
  const skipped: UpdateSkip[] = [];
  const assumed: string[] = [];

  // One after another on purpose: the queue runs them serially anyway, and a bad folder must not stop
  // the rest. Sorted so every click queues in the same order.
  const entries = [...context.accounts].sort((a, b) =>
    a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0,
  );
  for (const entry of entries) {
    // Before the spec is built: a folder that is already running is a harmless skip, even when gather
    // could not rebuild its spec.
    const running = runQueue.findActive(entry.folder);
    if (running) {
      skipped.push({ folder: entry.folder, reason: activeSkipReason(running.status) });
      continue;
    }

    const built = buildUpdateSpec(entry.folder, entry, context.runs, context.settings);
    if (!built.ok) {
      skipped.push({ folder: entry.folder, reason: built.error });
      continue;
    }

    const queued = await queueUpdate(entry.folder, built.data);
    if (!queued.ok) {
      skipped.push({
        folder: entry.folder,
        reason: queued.active ? activeSkipReason(queued.active) : "The update couldn't be started.",
      });
      continue;
    }

    started += 1;
    if (built.data.assumedSite) assumed.push(entry.folder);
  }

  if (started > 0) revalidatePath("/history");
  return { ok: true, data: { started, skipped, assumed } };
}
