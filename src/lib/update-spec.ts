import type {
  ActionResult,
  Advanced,
  DetectedLayout,
  JobSpec,
  Layout,
  LibraryEntry,
  Run,
  Settings,
} from "@/lib/spec";
import { createDefaultSpec } from "@/lib/spec";
import { compareRunIds } from "@/lib/run-order";
import { parseJobSpec } from "@/lib/spec-schema";
import { folderNameFor, validateAccount } from "@/lib/sites";

/** "Stop when caught up": gallery-dl stops after this many files the account already has (DESIGN §6). */
export const CAUGHT_UP_AFTER = 20;

export interface UpdatePlan {
  spec: JobSpec;
  /** Set when the folder had no run history and the X site was assumed from the folder name. */
  assumedSite?: "x";
}

export interface UpdateAccountData {
  runId: string;
  assumedSite?: "x";
}

export interface UpdateSkip {
  folder: string;
  reason: string;
}

export interface UpdateAllResult {
  started: number;
  skipped: UpdateSkip[];
  assumed: string[];
}

/** Windows folder names are case-insensitive; the queue compares folders the same way. */
export function folderKey(folder: string): string {
  return process.platform === "win32" ? folder.toLowerCase() : folder;
}

/** The folder's runs, newest first. Queued runs have no startedAt, so the id decides the order. */
export function runsForFolder(folder: string, runs: readonly Run[]): Run[] {
  return runs
    .filter((run) => folderKey(folderNameFor(run.spec)) === folderKey(folder))
    .sort((a, b) => compareRunIds(a.id, b.id));
}

/**
 * The spec behind a Library "Update": the account's preferences from its latest run, minus everything
 * that belonged to that one run (preview, --range, date window, --no-skip).
 */
export function buildUpdateSpec(
  folder: string,
  entry: LibraryEntry,
  runs: readonly Run[],
  settings: Settings,
): ActionResult<UpdatePlan> {
  const history = runsForFolder(folder, runs);
  // A preview never downloads, but it is still the best record of where the account lives.
  const previous = history.find((run) => !run.spec.simulate) ?? history[0];

  if (!previous) {
    const guessed = validateAccount("x", folder);
    if (!guessed.ok) {
      return {
        ok: false,
        error: `gather doesn't know which site ${folder} came from. Run it once from the Run page first.`,
      };
    }
    const base: JobSpec = {
      ...createDefaultSpec(settings),
      account: guessed.account,
      layout: layoutFromDisk(entry.layout),
    };
    return carriedOver(base, true, "x");
  }

  // Stopping after 20 skipped files assumes everything older is already downloaded. That only holds when
  // the last real run walked the whole account: a failed, stopped or --range run leaves a backlog behind.
  const walkedEverything =
    !previous.spec.simulate && previous.status === "done" && previous.spec.advanced.range === undefined;
  return carriedOver(previous.spec, walkedEverything);
}

function carriedOver(base: JobSpec, caughtUp: boolean, assumedSite?: "x"): ActionResult<UpdatePlan> {
  const advanced: Advanced = { ...base.advanced, noSkip: false };
  delete advanced.range;
  if (caughtUp) advanced.abortAfterSkipped = CAUGHT_UP_AFTER;
  else delete advanced.abortAfterSkipped;

  const spec: JobSpec = { ...base, simulate: false, advanced };
  delete spec.dateFrom;
  delete spec.dateTo;

  const parsed = parseJobSpec(spec);
  if (!parsed.ok) return parsed;
  return { ok: true, data: assumedSite ? { spec: parsed.data, assumedSite } : { spec: parsed.data } };
}

function layoutFromDisk(detected: DetectedLayout): Layout {
  return detected === "unknown" ? { kind: "byType" } : { kind: detected };
}
