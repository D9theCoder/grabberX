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
import { isActiveStatus } from "@/lib/run-copy";
import { compareRunIds } from "@/lib/run-order";
import { parseJobSpec } from "@/lib/spec-schema";
import { folderNameFor, validateAccount } from "@/lib/sites";
import { checkpointFromIso, cutoffSiteOf, minPostId, tipForSpec } from "@/lib/twitter-id";
import type { ArchiveTip } from "@/lib/twitter-id";

/** "Stop when caught up": gallery-dl stops after this many files the account already has (DESIGN §6). */
export const CAUGHT_UP_AFTER = 20;

export interface BuildUpdateOptions {
  /** Newest post IDs already stored in the folder's `archive.sqlite3`. */
  archiveTip?: ArchiveTip;
}

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
 * Enriches a Library folder entry with its latest real run timestamp and whether all contents are
 * currently up to date (latest non-preview run was unbounded, finished `done` with 0 failures, and
 * no run is currently active for the folder).
 */
export function enrichLibraryEntry(
  entry: LibraryEntry,
  runs: readonly Run[],
  activeRuns: readonly Run[] = [],
): LibraryEntry {
  const key = folderKey(entry.folder);
  const hasActive = activeRuns.some(
    (run) => isActiveStatus(run.status) && folderKey(folderNameFor(run.spec)) === key,
  );
  const history = runsForFolder(entry.folder, runs);
  const latestReal = history.find((run) => !run.spec.simulate);
  const latestAny = latestReal ?? history[0];
  const runTime = latestReal?.endedAt ?? latestReal?.startedAt;
  const lastRunAt = newerIso(entry.lastRunAt, runTime);
  const upToDate =
    !hasActive &&
    latestReal !== undefined &&
    latestReal.status === "done" &&
    latestReal.counts.failed === 0 &&
    latestReal.spec.advanced.range === undefined &&
    latestReal.spec.dateFrom === undefined &&
    latestReal.spec.dateTo === undefined;
  const lastRunFailed =
    latestReal !== undefined && (latestReal.status === "failed" || latestReal.counts.failed > 0);

  return {
    ...entry,
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(latestAny ? { site: latestAny.spec.site } : {}),
    ...(latestReal ? { lastRunStatus: latestReal.status } : {}),
    lastRunFailed,
    upToDate,
  };
}

function newerIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb >= ta ? b : a;
}

/** True when `run` walked the whole feed for everything `target` wants, leaving no older backlog. */
function isCompleteRun(run: Run, target: JobSpec): boolean {
  if (run.spec.simulate || run.status !== "done") return false;
  if (run.spec.advanced.range !== undefined) return false;
  if (run.spec.dateFrom !== undefined || run.spec.dateTo !== undefined) return false;
  if (run.spec.media !== "all" && run.spec.media !== target.media) return false;
  if (target.site === "x") {
    if (target.advanced.retweets && !run.spec.advanced.retweets) return false;
    if (target.advanced.replies && !run.spec.advanced.replies) return false;
  }
  return true;
}

/**
 * The spec behind a Library "Update": the account's preferences from its latest run, minus everything
 * that belonged to that one run (preview, --range, date window, --no-skip), plus an incremental cutoff
 * so updates fetch only new posts instead of walking the entire stored history.
 */
export function buildUpdateSpec(
  folder: string,
  entry: LibraryEntry,
  runs: readonly Run[],
  settings: Settings,
  options: BuildUpdateOptions = {},
): ActionResult<UpdatePlan> {
  const history = runsForFolder(folder, runs);
  const realRuns = history.filter((run) => !run.spec.simulate);
  // A preview never downloads, but it is still the best record of where the account lives.
  const previous = realRuns[0] ?? history[0];

  if (!previous) {
    const guessed = validateAccount("x", folder);
    if (!guessed.ok) {
      return {
        ok: false,
        error: `grabberX doesn't know which site ${folder} came from. Run it once from the Run page first.`,
      };
    }
    const base: JobSpec = {
      ...createDefaultSpec(settings),
      account: guessed.account,
      layout: layoutFromDisk(entry.layout),
    };
    return carriedOver(base, { caughtUp: true, sincePostId: tipForSpec(base, options.archiveTip) }, "x");
  }

  if (previous.spec.simulate) {
    return carriedOver(previous.spec, { caughtUp: false });
  }

  const cutoffSite = cutoffSiteOf(previous.spec);
  const archiveId = tipForSpec(previous.spec, options.archiveTip);
  const completeIndex = realRuns.findIndex((run) => isCompleteRun(run, previous.spec));

  if (completeIndex === 0) {
    // Latest real run finished cleanly across all steps: the archive tip is consistent for every media type.
    return carriedOver(previous.spec, { caughtUp: true, sincePostId: archiveId });
  }

  if (completeIndex > 0) {
    // An earlier full run completed, followed by one or more failed/stopped/limited runs.
    const newerSaved = realRuns.slice(0, completeIndex).some((run) => run.counts.saved > 0);
    if (!newerSaved) {
      // Nothing new was written since the last completed run, so the archive tip is still consistent.
      return carriedOver(previous.spec, { caughtUp: true, sincePostId: archiveId });
    }
    // A failed run saved some files (e.g. Step 1 images before Step 2 videos failed), so the archive tip
    // may be ahead of videos. Bound the retry by the last completed run's checkpoint instead of walking all
    // history, and leave -T off so Step 1 doesn't stop before reaching that checkpoint.
    const lastComplete = realRuns[completeIndex]!;
    const checkpoint =
      lastComplete.newestPostId ??
      (cutoffSite && lastComplete.startedAt
        ? checkpointFromIso(cutoffSite, lastComplete.startedAt)
        : undefined);
    const safeSinceId =
      cutoffSite !== null && checkpoint ? minPostId(archiveId, checkpoint) : undefined;
    return carriedOver(previous.spec, { caughtUp: false, sincePostId: safeSinceId });
  }

  // No completed run is in history. If every grabberX run on this folder saved nothing and only skipped
  // files already in archive.sqlite3 (e.g. an imported folder whose first Update hit a rate limit), trust
  // the archive tip so it recovers instead of spiraling into full-history walks.
  const onlySkippedExisting =
    archiveId !== undefined &&
    realRuns.every((run) => run.counts.saved === 0) &&
    realRuns.some((run) => run.counts.skipped > 0);
  if (onlySkippedExisting) {
    return carriedOver(previous.spec, { caughtUp: true, sincePostId: archiveId });
  }

  return carriedOver(previous.spec, { caughtUp: false });
}

function carriedOver(
  base: JobSpec,
  stop: { caughtUp: boolean; sincePostId?: string },
  assumedSite?: "x",
): ActionResult<UpdatePlan> {
  const advanced: Advanced = { ...base.advanced, noSkip: false };
  delete advanced.range;
  if (stop.caughtUp) advanced.abortAfterSkipped = CAUGHT_UP_AFTER;
  else delete advanced.abortAfterSkipped;
  if (cutoffSiteOf(base) !== null && stop.sincePostId) advanced.sincePostId = stop.sincePostId;
  else delete advanced.sincePostId;

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
