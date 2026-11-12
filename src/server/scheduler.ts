import "server-only";
import {
  type PassResult,
  type ScheduleFrequency,
  type ScheduleState,
  frequencyKey,
  nextRunAt,
  passNotification,
  planSchedule,
} from "@/lib/schedule";
import { isActiveStatus } from "@/lib/run-copy";
import type { JobSpec, LibraryEntry, Run, Settings } from "@/lib/spec";
import { buildUpdateSpec, folderKey } from "@/lib/update-spec";

/** After a missed moment: one pass, a little later, so it does not race the first page load. */
export const CATCH_UP_DELAY_MS = 10_000;
/** While a manual run is queued or running, try again rather than interleave. */
export const RETRY_DELAY_MS = 5 * 60_000;
/** After this many retries the occurrence is given up and the next scheduled time takes over. */
export const MAX_RETRIES = 12;
/** How often an idle scheduler re-reads the clock and the saved plan, so a sleeping PC catches up. */
export const TICK_MS = 30_000;

const ALL_RUNS = Number.MAX_SAFE_INTEGER;

export interface SchedulerDeps {
  getSettings(): Promise<Settings>;
  getState(): Promise<ScheduleState>;
  saveState(state: ScheduleState): Promise<void>;
  listAccounts(): Promise<LibraryEntry[]>;
  listRuns(limit: number): Promise<Run[]>;
  /** Runs that are queued, running or stopping right now. */
  activeRuns(): Run[];
  findActive(folder: string): Run | undefined;
  enqueue(spec: JobSpec, options?: { scheduled?: boolean }): Promise<Run>;
  waitFor(id: string): Promise<Run | undefined>;
  notify(body: string): void;
  now(): Date;
}

/**
 * Enqueues the same job as "Update all" on a timer. It never starts while a manual run is active or
 * queued, never starts a second pass of its own, and catches up once after the app was closed over a
 * scheduled time. The time rules themselves live in `src/lib/schedule.ts`.
 */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private timer?: NodeJS.Timeout;
  private started = false;
  private passRunning = false;
  private pendingPassAt?: number;
  private retries = 0;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.tick();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
  }

  /** After the schedule settings change: forget a pending catch-up and plan again from the file. */
  async refresh(): Promise<void> {
    if (!this.started) return;
    this.pendingPassAt = undefined;
    this.retries = 0;
    await this.tick();
  }

  async tick(): Promise<void> {
    if (!this.started) return;
    this.clearTimer();
    const deps = this.deps;
    let settings: Settings;
    try {
      settings = await deps.getSettings();
    } catch (error) {
      console.error("grabberX: could not read the settings for the update schedule.", error);
      this.arm(TICK_MS);
      return;
    }
    // A disabled schedule arms nothing; saving the settings calls refresh() and re-arms it.
    if (!settings.schedule.enabled) return;

    const now = deps.now();
    let dueAt: number;
    try {
      dueAt = await this.dueAt(settings, now);
    } catch (error) {
      console.error("grabberX: could not plan the next update.", error);
      this.arm(TICK_MS);
      return;
    }
    if (!this.started) return;
    if (this.passRunning) {
      this.arm(TICK_MS);
      return;
    }
    const wait = dueAt - now.getTime();
    if (wait > 0) {
      // The cap makes this a heartbeat: a PC that slept through the due time catches up on waking,
      // which a single long setTimeout would not.
      this.arm(Math.min(wait, TICK_MS));
      return;
    }
    await this.runPass(settings);
  }

  private async dueAt(settings: Settings, now: Date): Promise<number> {
    if (this.pendingPassAt !== undefined) return this.pendingPassAt;
    const deps = this.deps;
    const frequency = settings.schedule.frequency;
    const state = await deps.getState().catch((): ScheduleState => ({}));
    const plan = planSchedule(frequency, state, now);

    if (plan.catchUp) {
      // Whatever was missed, only one pass runs, and the plan moves to the next scheduled moment.
      this.pendingPassAt = now.getTime() + CATCH_UP_DELAY_MS;
      await this.persist(frequency, nextRunAt(frequency, now));
      return this.pendingPassAt;
    }
    if (state.nextDueAt !== plan.nextDueAt.toISOString() || state.frequency !== frequencyKey(frequency)) {
      await this.persist(frequency, plan.nextDueAt);
    }
    return plan.nextDueAt.getTime();
  }

  private async runPass(settings: Settings): Promise<void> {
    const deps = this.deps;
    const now = deps.now();
    const busy = deps.activeRuns().filter((run) => isActiveStatus(run.status));

    if (busy.length > 0) {
      // A manual run owns the session and the rate limit. Wait for it, but not forever: after the
      // last retry the next scheduled moment takes over.
      if (this.retries >= MAX_RETRIES) {
        this.retries = 0;
        this.pendingPassAt = undefined;
        await this.persist(settings.schedule.frequency, nextRunAt(settings.schedule.frequency, now));
        this.arm(TICK_MS);
        return;
      }
      this.retries += 1;
      this.pendingPassAt = now.getTime() + RETRY_DELAY_MS;
      this.arm(RETRY_DELAY_MS);
      return;
    }

    this.passRunning = true;
    this.pendingPassAt = undefined;
    this.retries = 0;
    try {
      // Move the plan on before the pass: a crash in the middle must not replay it at the next launch.
      await this.persist(settings.schedule.frequency, nextRunAt(settings.schedule.frequency, now));
      const ids = await this.enqueuePass(settings);
      if (ids.length > 0) {
        const finished = await Promise.all(ids.map((id) => deps.waitFor(id)));
        this.notify(finished);
      }
    } catch (error) {
      console.error("grabberX: the scheduled update pass failed.", error);
    } finally {
      this.passRunning = false;
      if (this.started) this.arm(TICK_MS);
    }
  }

  private async enqueuePass(settings: Settings): Promise<string[]> {
    const deps = this.deps;
    const [accounts, runs] = await Promise.all([deps.listAccounts(), deps.listRuns(ALL_RUNS)]);
    const paused = new Set(settings.pausedAccounts.map(folderKey));
    const ordered = [...accounts].sort((a, b) =>
      a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0,
    );

    const ids: string[] = [];
    for (const entry of ordered) {
      if (paused.has(folderKey(entry.folder))) continue;
      // An account that is already queued or running is left alone: a second run would wait behind
      // the first, and the queue refuses two at once on one archive anyway.
      if (deps.findActive(entry.folder)) continue;
      const built = buildUpdateSpec(entry.folder, entry, runs, settings);
      if (!built.ok) {
        console.warn(`grabberX: the scheduled update skipped ${entry.folder}: ${built.error}`);
        continue;
      }
      try {
        const run = await deps.enqueue(built.data.spec, { scheduled: true });
        ids.push(run.id);
      } catch (error) {
        console.error(`grabberX: could not queue the scheduled update for ${entry.folder}.`, error);
      }
    }
    return ids;
  }

  private notify(finished: ReadonlyArray<Run | undefined>): void {
    const runs = finished.filter((run): run is Run => run !== undefined);
    const summary: PassResult = {
      saved: runs.reduce((total, run) => total + run.counts.saved, 0),
      accounts: runs.filter((run) => run.counts.saved > 0).length,
      failed: runs.filter((run) => run.status === "failed").length,
      authFailed: runs.filter((run) => run.status === "failed" && run.errorKind === "auth").length,
    };
    const body = passNotification(summary);
    if (!body) return;
    try {
      this.deps.notify(body);
    } catch (error) {
      console.error("grabberX: could not show the update notification.", error);
    }
  }

  private async persist(frequency: ScheduleFrequency, nextDueAt: Date): Promise<void> {
    await this.deps
      .saveState({ nextDueAt: nextDueAt.toISOString(), frequency: frequencyKey(frequency) })
      .catch((error: unknown) => {
        console.error("grabberX: could not save the update schedule.", error);
      });
  }

  private arm(ms: number): void {
    this.clearTimer();
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, Math.max(0, ms));
    // A timer must not keep a short-lived process (a test, `next build`) alive.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

async function defaultDeps(): Promise<SchedulerDeps> {
  const [queueModule, store, library] = await Promise.all([
    import("@/server/run-queue"),
    import("@/server/store"),
    import("@/server/library"),
  ]);
  const queue = queueModule.runQueue;
  return {
    getSettings: store.getSettings,
    getState: store.getScheduleState,
    saveState: store.saveScheduleState,
    listAccounts: library.listAccounts,
    listRuns: store.listRuns,
    activeRuns: () => queue.list(),
    findActive: (folder) => queue.findActive(folder),
    enqueue: (spec, options) => queue.enqueue(spec, options),
    waitFor: (id) => queue.waitFor(id),
    notify: notifyShell,
    now: () => new Date(),
  };
}

/**
 * The Electron shell starts the server as a utility process. A pass that finishes while the window
 * is closed in the tray has no page to speak to, so the notice goes up to the shell.
 */
function notifyShell(body: string): void {
  const parentPort = (process as unknown as { parentPort?: { postMessage(message: unknown): void } })
    .parentPort;
  if (!parentPort) return;
  try {
    parentPort.postMessage({ kind: "scheduled-pass", body });
  } catch (error) {
    console.error("grabberX: could not pass the update notification to the shell.", error);
  }
}

interface SchedulerGlobal {
  __gatherScheduler?: Promise<Scheduler>;
}

const globals = globalThis as unknown as SchedulerGlobal;

function instance(): Promise<Scheduler> {
  globals.__gatherScheduler ??= defaultDeps().then((deps) => new Scheduler(deps));
  return globals.__gatherScheduler;
}

export function startScheduler(): void {
  void instance().then(
    (scheduler) => scheduler.start(),
    (error: unknown) => console.error("grabberX: could not start the update schedule.", error),
  );
}

export async function stopScheduler(): Promise<void> {
  const pending = globals.__gatherScheduler;
  if (!pending) return;
  const scheduler = await pending.catch(() => undefined);
  scheduler?.stop();
}

/**
 * Called after the schedule settings change. A process that never started a scheduler, such as a
 * route test, does nothing instead of creating timers.
 */
export async function refreshScheduler(): Promise<void> {
  const pending = globals.__gatherScheduler;
  if (!pending) return;
  const scheduler = await pending.catch(() => undefined);
  await scheduler?.refresh();
}
