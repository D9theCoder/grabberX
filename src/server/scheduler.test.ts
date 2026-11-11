import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorKind, JobSpec, LibraryEntry, Run, RunStatus, Settings } from "@/lib/spec";
import type { ScheduleFrequency, ScheduleState } from "@/lib/schedule";
import { frequencyKey } from "@/lib/schedule";
import {
  CATCH_UP_DELAY_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  Scheduler,
  TICK_MS,
} from "@/server/scheduler";
import type { SchedulerDeps } from "@/server/scheduler";

interface Outcome {
  saved: number;
  status?: RunStatus;
  errorKind?: ErrorKind;
}

interface Harness {
  scheduler: Scheduler;
  settings: Settings;
  state: ScheduleState;
  enqueued: JobSpec[];
  scheduledFlags: Array<boolean | undefined>;
  notifications: string[];
  active: Run[];
  /** Holds every `waitFor` open, so a pass counts as still running. */
  holdPass(): void;
  releasePass(): void;
}

function specFor(account: string): JobSpec {
  return {
    site: "x",
    account,
    media: "all",
    layout: { kind: "byType" },
    simulate: false,
    advanced: {
      imageSize: "orig",
      retweets: false,
      replies: true,
      writeMetadata: false,
      noSkip: false,
      cookies: { browser: "firefox" },
    },
  };
}

function makeRun(account: string, id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    spec: specFor(account),
    steps: [],
    status: "queued",
    stepIndex: 0,
    counts: { saved: 0, skipped: 0, failed: 0 },
    ...overrides,
  };
}

function baseSettings(frequency: ScheduleFrequency): Settings {
  return {
    galleryDlPath: "C:\\tools\\gallery-dl.exe",
    mediaRoot: "D:\\Photos\\p\\scrapper",
    cookies: { browser: "firefox" },
    defaultMedia: "all",
    defaultLayout: { kind: "byType" },
    historyRetention: 200,
    concurrency: 1,
    schedule: { enabled: true, frequency },
    pausedAccounts: [],
  };
}

/**
 * A scheduler wired to fakes instead of the queue and the disk. The clock comes from vitest's fake
 * timers, so a whole night passes in milliseconds.
 */
function harness(
  options: {
    settings?: Partial<Settings>;
    frequency?: ScheduleFrequency;
    state?: ScheduleState;
    accounts?: string[];
    outcomes?: Record<string, Outcome>;
    active?: Run[];
    /** Accounts whose enqueue is in flight: the queue does not list them as running yet. */
    enqueuing?: string[];
    history?: Run[];
  } = {},
): Harness {
  const settings: Settings = {
    ...baseSettings(options.frequency ?? { kind: "daily", time: "03:00" }),
    ...options.settings,
  };
  const state: ScheduleState = { ...options.state };
  const accounts = (options.accounts ?? ["username", "example_user"]).map(
    (folder): LibraryEntry => ({ folder, layout: "byType" }),
  );
  const outcomes = options.outcomes ?? {};
  const active: Run[] = [...(options.active ?? [])];
  const enqueued: JobSpec[] = [];
  const scheduledFlags: Array<boolean | undefined> = [];
  const notifications: string[] = [];
  const created = new Map<string, Run>();
  let gate: Promise<void> | undefined;
  let openGate: () => void = () => {};

  const deps: SchedulerDeps = {
    getSettings: async () => structuredClone(settings),
    getState: async () => ({ ...state }),
    saveState: async (next) => {
      delete state.nextDueAt;
      delete state.frequency;
      Object.assign(state, next);
    },
    listAccounts: async () => accounts,
    listRuns: async () => options.history ?? [],
    activeRuns: () => active,
    findActive: (folder) =>
      active.find((run) => run.spec.account === folder) ??
      (options.enqueuing?.includes(folder) ? makeRun(folder, `pending-${folder}`) : undefined),
    enqueue: async (spec, enqueueOptions) => {
      enqueued.push(spec);
      scheduledFlags.push(enqueueOptions?.scheduled);
      const run = makeRun(spec.account, `run-${enqueued.length}`, {
        ...(enqueueOptions?.scheduled ? { scheduled: true } : {}),
      });
      created.set(run.id, run);
      return run;
    },
    waitFor: async (id) => {
      if (gate) await gate;
      const run = created.get(id);
      if (!run) return undefined;
      const outcome = outcomes[run.spec.account] ?? { saved: 0 };
      return {
        ...run,
        status: outcome.status ?? "done",
        counts: { saved: outcome.saved, skipped: 0, failed: 0 },
        ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
      };
    },
    notify: (body) => notifications.push(body),
    now: () => new Date(),
  };

  return {
    scheduler: new Scheduler(deps),
    settings,
    state,
    enqueued,
    scheduledFlags,
    notifications,
    active,
    holdPass() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    releasePass() {
      openGate();
      gate = undefined;
    },
  };
}

/** Lets every pending promise settle before the clock moves on. */
async function settle(): Promise<void> {
  // The scheduler starts its work from a timer with `void`, so a fake-timer advance does not wait
  // for it; the test drains the promise chain itself.
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

/** Moves the clock, then lets the work the timer started finish (the scheduler does not await it). */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function local(iso: string | undefined): string {
  const date = new Date(iso ?? "");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 12, 1, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Scheduler", () => {
  it("does nothing while automatic updates are off", async () => {
    const h = harness({
      settings: { schedule: { enabled: false, frequency: { kind: "daily", time: "03:00" } } },
    });
    h.scheduler.start();
    await advance(2 * 24 * 60 * 60 * 1000);
    expect(h.enqueued).toEqual([]);
    expect(h.state).toEqual({});
    h.scheduler.stop();
  });

  it("starts one pass at the daily time and plans the next day", async () => {
    const h = harness();
    h.scheduler.start();
    await settle();
    expect(h.state.frequency).toBe("daily:03:00");
    expect(local(h.state.nextDueAt)).toBe("2026-11-12 03:00");
    expect(h.enqueued).toEqual([]);

    await advance(2 * 60 * 60 * 1000);
    expect(h.enqueued.map((spec) => spec.account)).toEqual(["example_user", "username"]);
    expect(h.scheduledFlags).toEqual([true, true]);
    expect(local(h.state.nextDueAt)).toBe("2026-11-13 03:00");

    // A day later, exactly one more pass has run.
    await advance(24 * 60 * 60 * 1000);
    expect(h.enqueued).toHaveLength(4);
    h.scheduler.stop();
  });

  it("catches up once after the app was closed over the scheduled time", async () => {
    vi.setSystemTime(new Date(2026, 10, 12, 12, 0));
    const missed = new Date(2026, 10, 8, 3, 0);
    const h = harness({ state: { nextDueAt: missed.toISOString(), frequency: "daily:03:00" } });
    h.scheduler.start();
    await settle();
    // Not at once: a short delay after launch, so the pass does not race the first page load.
    expect(h.enqueued).toEqual([]);
    expect(local(h.state.nextDueAt)).toBe("2026-11-13 03:00");

    await advance(CATCH_UP_DELAY_MS);
    // Three missed days still mean one pass, and the next one is tomorrow.
    expect(h.enqueued).toHaveLength(2);
    expect(local(h.state.nextDueAt)).toBe("2026-11-13 03:00");
    await advance(60 * 60 * 1000);
    expect(h.enqueued).toHaveLength(2);
    h.scheduler.stop();
  });

  it("waits for a manual run instead of starting beside it", async () => {
    const h = harness({ active: [makeRun("username", "manual-1", { status: "running" })] });
    h.scheduler.start();
    await advance(2 * 60 * 60 * 1000);
    expect(h.enqueued).toEqual([]);

    // The manual run finishes; the next retry picks the pass up.
    h.active.length = 0;
    await advance(RETRY_DELAY_MS);
    expect(h.enqueued.map((spec) => spec.account)).toEqual(["example_user", "username"]);
    h.scheduler.stop();
  });

  it("gives up an occurrence after a run that never ends", async () => {
    const h = harness({ active: [makeRun("username", "manual-1", { status: "running" })] });
    h.scheduler.start();
    await settle();
    // Two hours to the due time, then one retry every five minutes until the last one gives up.
    await advance(2 * 60 * 60 * 1000 + MAX_RETRIES * RETRY_DELAY_MS + 60 * 1000);
    expect(h.enqueued).toEqual([]);
    // The pass resumes at the next scheduled moment instead.
    expect(local(h.state.nextDueAt)).toBe("2026-11-13 03:00");
    h.scheduler.stop();
  });

  it("skips paused accounts and accounts whose update is already on its way", async () => {
    const h = harness({
      accounts: ["busy", "paused", "username"],
      // The queue has not registered these yet, so a second enqueue would slip past its account lock.
      enqueuing: ["busy"],
      settings: { pausedAccounts: ["paused"] },
    });
    h.scheduler.start();
    await settle();
    await advance(2 * 60 * 60 * 1000);
    expect(h.enqueued.map((spec) => spec.account)).toEqual(["username"]);
    h.scheduler.stop();
  });

  it("never starts a second pass while one is running", async () => {
    const h = harness({ frequency: { kind: "everyHours", hours: 1 } });
    h.holdPass();
    h.scheduler.start();
    await advance(60 * 60 * 1000);
    expect(h.enqueued).toHaveLength(2);

    // Hours later the first pass is still waiting for its runs.
    await advance(3 * 60 * 60 * 1000);
    expect(h.enqueued).toHaveLength(2);

    h.releasePass();
    await settle();
    await advance(60 * 60 * 1000);
    expect(h.enqueued).toHaveLength(4);
    h.scheduler.stop();
  });

  it("says how many files and accounts a pass brought in", async () => {
    const h = harness({ outcomes: { username: { saved: 5 }, example_user: { saved: 7 } } });
    h.scheduler.start();
    await advance(2 * 60 * 60 * 1000);
    expect(h.notifications).toEqual(["12 new files from 2 accounts"]);
    h.scheduler.stop();
  });

  it("shows no notification when nothing changed", async () => {
    const h = harness({ outcomes: { username: { saved: 0 }, example_user: { saved: 0 } } });
    h.scheduler.start();
    await advance(2 * 60 * 60 * 1000);
    expect(h.notifications).toEqual([]);
    h.scheduler.stop();
  });

  it("asks for a sign-in when a failed account failed because of the login", async () => {
    const h = harness({
      outcomes: {
        username: { saved: 0, status: "failed", errorKind: "auth" },
        example_user: { saved: 2 },
      },
    });
    h.scheduler.start();
    await advance(2 * 60 * 60 * 1000);
    expect(h.notifications).toEqual(["Update failed for 1 account: sign in to x.com again"]);
    h.scheduler.stop();
  });

  it("replans when the frequency changed and runs on the new plan", async () => {
    const h = harness({
      state: { nextDueAt: new Date(2026, 10, 20, 3, 0).toISOString(), frequency: "daily:03:00" },
    });
    h.settings.schedule.frequency = { kind: "everyHours", hours: 6 };
    h.scheduler.start();
    await settle();
    expect(h.state.frequency).toBe(frequencyKey({ kind: "everyHours", hours: 6 }));
    expect(local(h.state.nextDueAt)).toBe("2026-11-12 07:00");

    await advance(6 * 60 * 60 * 1000);
    expect(h.enqueued).toHaveLength(2);
    h.scheduler.stop();
  });

  it("re-arms on refresh, so turning it on in Settings starts the countdown", async () => {
    const h = harness({
      settings: { schedule: { enabled: false, frequency: { kind: "everyHours", hours: 1 } } },
    });
    h.scheduler.start();
    await advance(TICK_MS);
    expect(h.enqueued).toEqual([]);

    h.settings.schedule.enabled = true;
    await h.scheduler.refresh();
    expect(local(h.state.nextDueAt)).toBe("2026-11-12 02:00");
    await advance(60 * 60 * 1000);
    expect(h.enqueued).toHaveLength(2);
    h.scheduler.stop();
  });

  it("stops for good on stop, even with a plan in the file", async () => {
    const h = harness();
    h.scheduler.start();
    await settle();
    h.scheduler.stop();
    await advance(48 * 60 * 60 * 1000);
    expect(h.enqueued).toEqual([]);
  });
});
