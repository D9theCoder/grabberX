import "server-only";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildCommand, stepTargetDir, WORKER_PARTS_DIR } from "@/lib/command";
import { pickErrorKind } from "@/lib/error-kind";
import { classifyError } from "@/lib/parse-line";
import { compareRunIds } from "@/lib/run-order";
import { isActiveStatus } from "@/lib/run-copy";
import { folderNameFor } from "@/lib/sites";
import type {
  ErrorKind,
  JobSpec,
  Run,
  RunEvent,
  RunStatus,
  Settings,
  Step,
  StreamEvent,
} from "@/lib/spec";
import { resolveAccountDir } from "@/server/paths";
import { folderChanged } from "@/server/warm-signal";
import { startProcess, sweepPartFiles } from "@/server/runner";
import type { ProcessHandle, StartProcess } from "@/server/runner";
import { startWorkers } from "@/server/workers";
import {
  appendLog,
  claimQueueLock,
  getRun,
  getSettings as loadSettings,
  isValidRunId,
  listRuns,
  pruneRuns,
  saveRun,
} from "@/server/store";

const BUFFERED_EVENTS = 500;
const LOG_FLUSH_MS = 250;
const LOG_FLUSH_BYTES = 64 * 1024;
const FINISHED_KEPT = 50;

const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "done",
  "failed",
  "stopped",
  "interrupted",
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

function normalizeFolder(folder: string): string {
  return process.platform === "win32" ? folder.toLowerCase() : folder;
}

function sameFolder(a: Run, b: Run): boolean {
  return normalizeFolder(folderNameFor(a.spec)) === normalizeFolder(folderNameFor(b.spec));
}

/**
 * Scheduling rule. Deliberately a separate pure function: the exact policy is expected to change
 * once "Update all" lands, and a table test is cheaper than a queue test.
 */
export function canStart(next: Run, running: Run[], limit: number): boolean {
  // Previews (spec.simulate) wait like downloads: --simulate still opens the account's archive.sqlite3.
  return running.length < limit && !running.some((run) => sameFolder(run, next));
}

function timeStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  ].join("T");
}

function cloneRun(run: Run): Run {
  return structuredClone(run);
}

interface QueueDeps {
  getSettings?: () => Promise<Settings>;
  startProcess?: StartProcess;
}

interface ActiveRun {
  run: Run;
  stopRequested: boolean;
  handle?: ProcessHandle;
  finished: Promise<void>;
  /** Kinds seen so far, not the lines: a verbose run can log error lines without end. */
  errorKinds: Set<ErrorKind>;
  logBuffer: string[];
  logBytes: number;
  logChain: Promise<void>;
  logTimer?: NodeJS.Timeout;
  lateFlush?: NodeJS.Timeout;
}

export class RunQueue {
  private readonly deps: Required<QueueDeps>;
  private readonly ready: Promise<void>;
  private readonly runs = new Map<string, Run>();
  /** Ids claimed by an enqueue that has not finished saving yet; see `allocateRunId`. */
  private readonly reserved = new Set<string>();
  private readonly requestOrder = new Map<string, number>();
  private requestCount = 0;
  private readonly active = new Map<string, ActiveRun>();
  private readonly buffers = new Map<string, RunEvent[]>();
  private readonly latestCounts = new Map<string, RunEvent>();
  private readonly latestStatus = new Map<string, RunEvent>();
  private readonly statusWrites = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<(event: StreamEvent) => void>>();
  private readonly finished: string[] = [];
  private idLock: Promise<void> = Promise.resolve();
  private pumping = false;
  private closing = false;
  private pumpAgain = false;

  constructor(deps: QueueDeps = {}) {
    this.deps = {
      getSettings: deps.getSettings ?? loadSettings,
      startProcess: deps.startProcess ?? startProcess,
    };
    this.ready = this.markInterrupted().catch((error: unknown) => {
      console.error("grabberX: could not clean up interrupted runs.", error);
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async enqueue(spec: JobSpec, options: { scheduled?: boolean } = {}): Promise<Run> {
    await this.ready;
    const settings = await this.deps.getSettings();
    const steps = buildCommand(spec, {
      mediaRoot: settings.mediaRoot,
      cookies: settings.cookies,
    });
    const id = await this.nextRunId(folderNameFor(spec));
    this.requestOrder.set(id, (this.requestCount += 1));
    const run: Run = {
      id,
      spec,
      steps,
      status: "queued",
      stepIndex: 0,
      counts: { saved: 0, skipped: 0, failed: 0 },
      ...(options.scheduled ? { scheduled: true } : {}),
    };
    // Persist before registering. A record that fails to save must leave nothing in memory, or a
    // later pump starts a download the user was told could not start.
    try {
      await saveRun(run);
    } catch (error) {
      this.reserved.delete(id);
      this.requestOrder.delete(id);
      throw error;
    }
    // The record is on disk, so `runs` now guards the id and the reservation is no longer needed.
    this.reserved.delete(id);
    this.runs.set(run.id, run);
    this.buffers.set(run.id, []);
    this.latestStatus.set(run.id, { t: "status", status: "queued", stepIndex: 0 });
    await this.pump();
    return cloneRun(run);
  }

  async stop(id: string): Promise<boolean> {
    await this.ready;
    if (!isValidRunId(id)) return false;
    const run = this.runs.get(id) ?? (await getRun(id));
    if (!run) return false;

    if (run.status === "queued") {
      run.endedAt = new Date().toISOString();
      await this.setStatus(run, "stopped");
      this.rememberFinished(id);
      return true;
    }

    const active = this.active.get(id);
    if (!active) return false;
    active.stopRequested = true;
    if (run.status !== "stopping") {
      await this.setStatus(run, "stopping");
    }
    await active.handle?.stop();
    await active.finished;
    return true;
  }

  /**
   * Stops every active run (taskkill on the tree, then the `.part` sweep) and starts nothing new, for when
   * the app is quitting. Runs still queued keep their record and are cleaned up on the next start.
   */
  async shutdown(): Promise<void> {
    await this.ready;
    this.closing = true;
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }

  get(id: string): Run | undefined {
    const run = this.runs.get(id);
    return run ? cloneRun(run) : undefined;
  }

  list(): Run[] {
    return [...this.runs.values()].filter((run) => isActiveStatus(run.status)).map(cloneRun);
  }

  findActive(folder: string): Run | undefined {
    const wanted = normalizeFolder(folder);
    for (const run of this.runs.values()) {
      if (!isActiveStatus(run.status)) continue;
      if (normalizeFolder(folderNameFor(run.spec)) === wanted) return cloneRun(run);
    }
    return undefined;
  }

  queuePosition(id: string): number {
    const index = this.queuedInOrder().findIndex((run) => run.id === id);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * First asked, first started. A run joins `runs` only after its record is saved, so overlapping
   * enqueues can register in a different order than they were requested; the sequence number keeps
   * the order of the requests (run ids cannot: two folders in one second sort by name).
   */
  private queuedInOrder(): Run[] {
    return [...this.runs.values()]
      .filter((run) => run.status === "queued")
      .sort((a, b) => {
        const left = this.requestOrder.get(a.id);
        const right = this.requestOrder.get(b.id);
        if (left !== undefined && right !== undefined) return left - right;
        // No request number (not queued through enqueue): fall back to the id, oldest first.
        return compareRunIds(b.id, a.id);
      });
  }

  /** Starts queued runs that can run now, e.g. after the concurrency limit was raised in Settings. */
  async resume(): Promise<void> {
    await this.ready;
    await this.pump();
  }

  subscribe(id: string, listener: (event: StreamEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(id);
    };
  }

  snapshot(id: string): { run: Run; events: RunEvent[] } | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const events = [...(this.buffers.get(id) ?? [])];
    const counts = this.latestCounts.get(id);
    if (counts) events.push(counts);
    const status =
      this.latestStatus.get(id) ??
      ({ t: "status", status: run.status, stepIndex: run.stepIndex } satisfies RunEvent);
    events.push(status);
    return { run: cloneRun(run), events };
  }

  /**
   * Resolves with the run once it reaches a terminal status. The scheduler uses it to know when a
   * whole pass has finished, without polling. An unknown or already finished run resolves at once.
   */
  waitFor(id: string): Promise<Run | undefined> {
    const finished = this.runs.get(id);
    if (!finished || isTerminalStatus(finished.status)) {
      return Promise.resolve(finished ? cloneRun(finished) : undefined);
    }
    return new Promise<Run | undefined>((resolve) => {
      const settle = (): void => {
        const run = this.runs.get(id);
        if (run && !isTerminalStatus(run.status)) return;
        unsubscribe();
        resolve(run ? cloneRun(run) : undefined);
      };
      const unsubscribe = this.subscribe(id, settle);
      // The status can change between the read above and the subscription.
      settle();
    });
  }

  /** Serialized so two enqueues in the same tick cannot both claim the same id. */
  private nextRunId(folder: string): Promise<string> {
    const allocated = this.idLock.then(() => this.allocateRunId(folder));
    this.idLock = allocated.then(
      () => {},
      () => {},
    );
    return allocated;
  }

  private async allocateRunId(folder: string): Promise<string> {
    const base = `${timeStamp(new Date())}_${folder}`;
    let id = base;
    let attempt = 1;
    // `reserved` covers the window where an enqueue has claimed an id but has not saved (and so has
    // not registered) it yet. Without it, two enqueues in one second would pick the same id.
    while (this.runs.has(id) || this.reserved.has(id) || (await getRun(id)) !== undefined) {
      attempt += 1;
      id = `${base}-${attempt}`;
    }
    this.reserved.add(id);
    return id;
  }

  private async pump(): Promise<void> {
    if (this.closing) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        let settings: Settings;
        try {
          settings = await this.deps.getSettings();
        } catch (error) {
          console.error("grabberX: could not read settings, so queued runs stay queued.", error);
          return;
        }
        for (const run of this.queuedInOrder()) {
          // The list is a snapshot, and beginRun awaits: a queued run can be stopped, and a running
          // one can end, meanwhile. Both are read fresh for every candidate.
          if (run.status !== "queued") continue;
          const running = [...this.active.values()].map((entry) => entry.run);
          if (!canStart(run, running, settings.concurrency)) continue;
          await this.beginRun(run, settings);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async beginRun(run: Run, settings: Settings): Promise<void> {
    // spawn() reports a missing working directory as ENOENT, which would read as "gallery-dl not found".
    await mkdir(settings.mediaRoot, { recursive: true }).catch(() => {});
    run.status = "running";
    run.startedAt = new Date().toISOString();
    run.stepIndex = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const active: ActiveRun = {
      run,
      stopRequested: false,
      finished: Promise.resolve(),
      errorKinds: new Set(),
      logBuffer: [],
      logBytes: 0,
      logChain: Promise.resolve(),
    };
    // `finished` is a real promise before the first await: a Stop that lands during the status write
    // below must wait for the work, not resolve against a placeholder. The gate holds the run until
    // the "running" status is saved, and `execute` then sees any stop that arrived meanwhile.
    active.finished = gate.then(() =>
      this.execute(active, settings).catch((error: unknown) =>
        this.failUnexpected(active, settings, error),
      ),
    );
    this.active.set(run.id, active);
    try {
      await this.setStatus(run, "running");
    } finally {
      openGate();
    }
  }

  private async execute(active: ActiveRun, settings: Settings): Promise<void> {
    const { run } = active;
    for (let index = 0; index < run.steps.length; index += 1) {
      // Checked before the write too: once Stop has set "stopping", writing "running" would undo it.
      if (active.stopRequested) break;
      if (index > 0) await this.setStatus(run, "running", index);
      // Stop can land while that status write is in flight. Recheck right before spawning, so no
      // process starts once a stop was requested.
      if (active.stopRequested) break;
      const step = run.steps[index];
      const handle = await this.startStep(active, settings, step);
      active.handle = handle;
      // Creating a parallel step's folder awaits; a Stop that landed meanwhile found no handle to stop.
      if (active.stopRequested) await handle.stop();
      const result = await handle.done;
      active.handle = undefined;
      if (step.workers) await this.removeWorkerParts(run, settings);
      if (result.exitCode !== null) run.exitCode = result.exitCode;
      if (active.stopRequested) break;
      if (result.spawnError) {
        await this.finalize(active, settings, "failed", {
          errorKind: result.spawnError === "ENOENT" ? "binaryMissing" : "unknown",
        });
        return;
      }
      if (result.exitCode !== 0) {
        await this.finalize(active, settings, "failed", {
          errorKind: pickErrorKind(active.errorKinds),
        });
        return;
      }
    }

    if (active.stopRequested) {
      await this.sweep(active.run, settings);
      await this.finalize(active, settings, "stopped");
      return;
    }
    await this.finalize(active, settings, "done");
  }

  /** One gallery-dl process, or for a parallel step its workers as one handle, log lines tagged "[2/4]". */
  private async startStep(active: ActiveRun, settings: Settings, step: Step): Promise<ProcessHandle> {
    const start = (argv: string[], tag?: string): ProcessHandle =>
      this.deps.startProcess({
        exe: settings.galleryDlPath,
        argv,
        cwd: settings.mediaRoot,
        onEvent: (event) => this.handleEvent(active, event),
        onRaw: (stream, line) => this.handleRaw(active, stream, tag ? `${tag} ${line}` : line),
      });
    const workers = step.workers;
    if (!workers || workers.length < 2) return start(step.argv);
    // gallery-dl creates a missing folder in a way that fails if another worker created it a moment earlier.
    // A preview writes nothing, so it creates no folder either.
    if (!active.run.spec.simulate) {
      try {
        await mkdir(stepTargetDir(active.run.spec, settings, step.label), { recursive: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.handleRaw(active, "stderr", `grabberX: could not create the folder for parallel downloads (${reason}); downloading one file at a time.`);
        return start(step.argv);
      }
    }
    return startWorkers(workers.map((argv, index) => () => start(argv, `[${index + 1}/${workers.length}]`)));
  }

  /** Each worker kept its unfinished files in its own folder; finished files were moved out, so this is empty or debris. */
  private async removeWorkerParts(run: Run, settings: Settings): Promise<void> {
    try {
      const dir = resolveAccountDir(settings.mediaRoot, folderNameFor(run.spec));
      await rm(join(dir, WORKER_PARTS_DIR), { recursive: true, force: true });
    } catch (error) {
      console.warn("grabberX: could not remove the parallel workers' unfinished files.", error);
    }
  }

  private handleEvent(active: ActiveRun, event: RunEvent): void {
    const { run } = active;
    switch (event.t) {
      case "file":
        if (event.kind === "saved") run.counts.saved += 1;
        else run.counts.skipped += 1;
        this.buffer(run.id, event);
        this.emit(run.id, event);
        this.emitCounts(run);
        break;
      case "log":
        if (event.level === "error") {
          run.counts.failed += 1;
          const kind = classifyError(event.line);
          if (kind) active.errorKinds.add(kind);
        }
        this.buffer(run.id, event);
        this.emit(run.id, event);
        if (event.level === "error") this.emitCounts(run);
        break;
      case "wait":
        this.buffer(run.id, event);
        this.emit(run.id, event);
        break;
      default:
        // counts and status belong to the queue, not to the parser.
        break;
    }
  }

  private handleRaw(active: ActiveRun, _stream: "stdout" | "stderr", line: string): void {
    const chunk = `${line}\n`;
    active.logBuffer.push(chunk);
    active.logBytes += chunk.length;
    if (active.logBytes >= LOG_FLUSH_BYTES) {
      void this.flushLog(active);
      return;
    }
    if (!this.active.has(active.run.id)) {
      // Finalize already cleared the interval. Late lines share one single-shot flush instead of
      // arming an interval nobody would clear, or writing once per line.
      if (!active.lateFlush) {
        active.lateFlush = setTimeout(() => {
          active.lateFlush = undefined;
          void this.flushLog(active);
        }, LOG_FLUSH_MS);
      }
      return;
    }
    if (active.logTimer) return;
    active.logTimer = setInterval(() => {
      void this.flushLog(active);
    }, LOG_FLUSH_MS);
    active.logTimer.unref?.();
  }

  private flushLog(active: ActiveRun): Promise<void> {
    if (active.logBuffer.length === 0) return active.logChain;
    const chunk = active.logBuffer.join("");
    active.logBuffer = [];
    active.logBytes = 0;
    const id = active.run.id;
    active.logChain = active.logChain
      .then(() => appendLog(id, chunk))
      .catch((error: unknown) => {
        console.error("grabberX: could not write the run log.", error);
      });
    return active.logChain;
  }

  private buffer(id: string, event: RunEvent): void {
    const events = this.buffers.get(id) ?? [];
    events.push(event);
    if (events.length > BUFFERED_EVENTS) events.splice(0, events.length - BUFFERED_EVENTS);
    this.buffers.set(id, events);
  }

  private emit(id: string, event: StreamEvent): void {
    const listeners = this.listeners.get(id);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("grabberX: an event listener failed.", error);
      }
    }
  }

  private emitCounts(run: Run): void {
    const event: RunEvent = {
      t: "counts",
      saved: run.counts.saved,
      skipped: run.counts.skipped,
      failed: run.counts.failed,
    };
    this.latestCounts.set(run.id, event);
    this.emit(run.id, event);
  }

  /**
   * Status writes are chained per run. `saveRun` is a file write, and two overlapping writes could
   * land in the opposite order, leaving a stale status on disk (History would then show a run as
   * running long after it ended). Chaining also keeps the status events in order.
   */
  private setStatus(
    run: Run,
    status: RunStatus,
    stepIndex: number = run.stepIndex,
  ): Promise<void> {
    run.status = status;
    run.stepIndex = stepIndex;
    const event: RunEvent = { t: "status", status, stepIndex };
    this.latestStatus.set(run.id, event);
    const previous = this.statusWrites.get(run.id) ?? Promise.resolve();
    const write: Promise<void> = previous
      .catch(() => {})
      .then(() => saveRun(run))
      .catch((error: unknown) => {
        console.error("grabberX: could not save the run record.", error);
      })
      .then(() => {
        this.emit(run.id, event);
      });
    this.statusWrites.set(run.id, write);
    return write;
  }

  private async finalize(
    active: ActiveRun,
    settings: Settings,
    status: RunStatus,
    extra: { errorKind?: ErrorKind } = {},
  ): Promise<void> {
    const { run } = active;
    if (!this.active.has(run.id)) return;
    this.active.delete(run.id);
    if (active.logTimer) {
      clearInterval(active.logTimer);
      active.logTimer = undefined;
    }
    run.endedAt = new Date().toISOString();
    if (extra.errorKind) run.errorKind = extra.errorKind;
    await this.flushLog(active);
    this.emitCounts(run);
    await this.setStatus(run, status);
    this.rememberFinished(run.id);
    await this.pump();
    void pruneRuns(settings.historyRetention).catch((error: unknown) => {
      console.error("grabberX: could not prune run history.", error);
    });
  }

  private async failUnexpected(
    active: ActiveRun,
    settings: Settings,
    error: unknown,
  ): Promise<void> {
    console.error("grabberX: a run failed unexpectedly.", error);
    await this.finalize(active, settings, "failed", { errorKind: "unknown" });
  }

  private async sweep(run: Run, settings: Settings): Promise<void> {
    try {
      const dir = resolveAccountDir(settings.mediaRoot, folderNameFor(run.spec));
      await sweepPartFiles(dir);
      if (!run.spec.simulate) folderChanged(dir);
    } catch (error) {
      console.warn("grabberX: could not clean up unfinished files.", error);
    }
  }

  private rememberFinished(id: string): void {
    this.finished.push(id);
    while (this.finished.length > FINISHED_KEPT) {
      const oldest = this.finished.shift();
      if (!oldest) break;
      this.runs.delete(oldest);
      this.buffers.delete(oldest);
      this.latestCounts.delete(oldest);
      this.latestStatus.delete(oldest);
      this.statusWrites.delete(oldest);
      this.requestOrder.delete(oldest);
    }
  }

  private async markInterrupted(): Promise<void> {
    if (!(await claimQueueLock())) return;
    const persisted = await listRuns(Number.MAX_SAFE_INTEGER);
    const stale = persisted.filter((run) => isActiveStatus(run.status));
    if (stale.length === 0) return;
    let settings: Settings | undefined;
    try {
      settings = await this.deps.getSettings();
    } catch {
      settings = undefined;
    }
    for (const run of stale) {
      run.status = "interrupted";
      run.endedAt = run.endedAt ?? new Date().toISOString();
      try {
        await saveRun(run);
      } catch (error) {
        console.error("grabberX: could not mark a run as interrupted.", error);
      }
      if (!settings) continue;
      await this.sweep(run, settings);
    }
  }
}

const globals = globalThis as unknown as { __gatherQueue?: RunQueue };

export const runQueue: RunQueue = (globals.__gatherQueue ??= new RunQueue());
