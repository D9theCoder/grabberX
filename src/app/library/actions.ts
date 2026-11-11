"use server";

import { revalidatePath } from "next/cache";
import { parseJobSpec } from "@/lib/spec-schema";
import { folderNameFor } from "@/lib/sites";
import { createDefaultSpec } from "@/lib/spec";
import type { ActionResult, DetectedLayout, JobSpec, Layout } from "@/lib/spec";
import { listAccounts } from "@/server/library";
import { runQueue } from "@/server/run-queue";
import { getSettings, listRuns } from "@/server/store";

const CAUGHT_UP_AFTER = 20;

function layoutFromDisk(detected: DetectedLayout): Layout {
  return detected === "unknown" ? { kind: "byType" } : { kind: detected };
}

async function specForUpdate(folder: string): Promise<ActionResult<JobSpec>> {
  const [settings, accounts, runs] = await Promise.all([getSettings(), listAccounts(), listRuns()]);
  const entry = accounts.find((account) => account.folder === folder);
  if (!entry) return { ok: false, error: "This account isn't in the library." };

  const previous = runs.find((run) => folderNameFor(run.spec) === folder);
  const base: JobSpec = previous
    ? previous.spec
    : { ...createDefaultSpec(settings), account: folder, layout: layoutFromDisk(entry.layout) };

  return parseJobSpec({
    ...base,
    simulate: false,
    advanced: { ...base.advanced, abortAfterSkipped: CAUGHT_UP_AFTER },
  });
}

export async function updateAccount(folder: string): Promise<ActionResult<{ runId: string }>> {
  const spec = await specForUpdate(folder);
  if (!spec.ok) return spec;

  try {
    const run = await runQueue.enqueue(spec.data);
    revalidatePath("/history");
    return { ok: true, data: { runId: run.id } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Couldn't start the update." };
  }
}

export async function updateAll(): Promise<ActionResult<{ started: number; skipped: string[] }>> {
  const accounts = await listAccounts();
  const skipped: string[] = [];
  let started = 0;

  // One after another on purpose: the queue runs them serially anyway, and a bad account must not stop the rest.
  for (const account of accounts) {
    const result = await updateAccount(account.folder);
    if (result.ok) started += 1;
    else skipped.push(account.folder);
  }
  return { ok: true, data: { started, skipped } };
}
