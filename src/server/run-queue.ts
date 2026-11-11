import "server-only";
import { buildCommand } from "@/lib/command";
import { classifyError } from "@/lib/parse-line";
import { folderNameFor } from "@/lib/sites";
import type {
  ErrorKind,
  JobSpec,
  Run,
  RunEvent,
  RunStatus,
  Settings,
  StreamEvent,
} from "@/lib/spec";
import { resolveAccountDir } from "@/server/paths";
import { startProcess, sweepPartFiles } from "@/server/runner";
import type { ProcessHandle, StartProcess } from "@/server/runner";
import {
  appendLog,
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

function isActiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "stopping";
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

function errorKindFor(lines: string[]): ErrorKind {
  for (const line of lines) {
    const kind = classifyError(line);
    if (kind) return kind;
  }
  return "unknown";
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
  errorLines: string[];
  logBuffer: string[];
  logBytes: number;
  logChain: Promise<void>;
  logTimer?: NodeJS.Timeout;
}

export class RunQueue {
  private readonly deps: Required<QueueDeps>;
  private readonly ready: Promise<void>;
  private readonly runs = new Map<string, Run>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly buffers = new Map<string, RunEvent[]>();
  private readonly latestCounts = new Map<string, RunEvent>();
  private readonly latestStatus = new Map<string, RunEvent>();
  private readonly listeners = new Map<string, Set<(event: StreamEvent) => void>>();
  private readonly finished: string[] = [];
  private idLock: Promise<void> = Promise.resolve();
  private pumping = false;
  private pumpAgain = false;

  constructor(deps: QueueDeps = {}) {
    this.deps = {
      getSettings: deps.getSettings ?? loadSettings,
      startProcess: deps.startProcess ?? startProcess,
    };
    this.ready = this.markInterrupted().catch((error: unknown) => {
      console.error("gather: could not clean up interrupted runs.", error);
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async enqueue(spec: JobSpec): Promise<Run> {
    await this.ready;
    const settings = await this.deps.getSettings();
    const steps = buildCommand(spec, {
      mediaRoot: settings.mediaRoot,
      cookies: settings.cookies,
    });
    const id = await this.nextRunId(folderNameFor(spec));
    const run: Run = {
      id,
      spec,
      steps,
      status: "queued",
      stepIndex: 0,
      counts: { saved: 0, skipped: 0, failed: 0 },
    };
    this.runs.set(run.id, run);
    this.buffers.set(run.id, []);
    this.latestStatus.set(run.id, { t: "status", status: "queued", stepIndex: 0 });
    await saveRun(run);
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
    const queued = [...this.runs.values()].filter((run) => run.status === "queued");
    const index = queued.findIndex((run) => run.id === id);
    return index === -1 ? 0 : index + 1;
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
    while (this.runs.has(id) || (await getRun(id)) !== undefined) {
      attempt += 1;
      id = `${base}-${attempt}`;
    }
    return id;
  }

  private async pump(): Promise<void> {
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
          console.error("gather: could not read settings, so queued runs stay queued.", error);
          return;
        }
        const running = [...this.active.values()].map((entry) => entry.run);
        for (const run of [...this.runs.values()]) {
          if (run.status !== "queued") continue;
          if (!canStart(run, running, settings.concurrency)) continue;
          await this.beginRun(run, settings);
          running.push(run);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async beginRun(run: Run, settings: Settings): Promise<void> {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    run.stepIndex = 0;
    const active: ActiveRun = {
      run,
      stopRequested: false,
      finished: Promise.resolve(),
      errorLines: [],
      logBuffer: [],
      logBytes: 0,
      logChain: Promise.resolve(),
    };
    this.active.set(run.id, active);
    await this.setStatus(run, "running");
    active.finished = this.execute(active, settings).catch((error: unknown) =>
      this.failUnexpected(active, settings, error),
    );
  }

  private async execute(active: ActiveRun, settings: Settings): Promise<void> {
    const { run } = active;
    for (let index = 0; index < run.steps.length; index += 1) {
      if (active.stopRequested) break;
      if (index > 0) await this.setStatus(run, "running", index);
      const step = run.steps[index];
      const handle = this.deps.startProcess({
        exe: settings.galleryDlPath,
        argv: step.argv,
        cwd: settings.mediaRoot,
        onEvent: (event) => this.handleEvent(active, event),
        onRaw: (stream, line) => this.handleRaw(active, stream, line),
      });
      active.handle = handle;
      const result = await handle.done;
      active.handle = undefined;
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
          errorKind: errorKindFor(active.errorLines),
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
          active.errorLines.push(event.line);
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
        console.error("gather: could not write the run log.", error);
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
        console.error("gather: an event listener failed.", error);
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

  private async setStatus(
    run: Run,
    status: RunStatus,
    stepIndex: number = run.stepIndex,
  ): Promise<void> {
    run.status = status;
    run.stepIndex = stepIndex;
    const event: RunEvent = { t: "status", status, stepIndex };
    this.latestStatus.set(run.id, event);
    try {
      await saveRun(run);
    } catch (error) {
      console.error("gather: could not save the run record.", error);
    }
    this.emit(run.id, event);
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
      console.error("gather: could not prune run history.", error);
    });
  }

  private async failUnexpected(
    active: ActiveRun,
    settings: Settings,
    error: unknown,
  ): Promise<void> {
    console.error("gather: a run failed unexpectedly.", error);
    await this.finalize(active, settings, "failed", { errorKind: "unknown" });
  }

  private async sweep(run: Run, settings: Settings): Promise<void> {
    try {
      const dir = resolveAccountDir(settings.mediaRoot, folderNameFor(run.spec));
      await sweepPartFiles(dir);
    } catch (error) {
      console.warn("gather: could not clean up unfinished files.", error);
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
    }
  }

  private async markInterrupted(): Promise<void> {
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
        console.error("gather: could not mark a run as interrupted.", error);
      }
      if (!settings) continue;
      await this.sweep(run, settings);
    }
  }
}

const globals = globalThis as unknown as { __gatherQueue?: RunQueue };

export const runQueue: RunQueue = (globals.__gatherQueue ??= new RunQueue());
