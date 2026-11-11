import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSpec, Run, RunEvent, RunStatus, Settings } from "@/lib/spec";
import type { StartProcess } from "@/server/runner";
import type { RunQueue as RunQueueClass } from "@/server/run-queue";

vi.mock("@/lib/sites", () => ({
  validateAccount: (_site: string, input: string) => ({ ok: true, account: input }),
  folderNameFor: (spec: { account: string; folder?: string }) => spec.folder ?? spec.account,
}));

vi.mock("@/lib/command", () => ({
  buildCommand: (spec: JobSpec) => [
    { label: "images", argv: ["images", spec.account] },
    { label: "videos", argv: ["videos", spec.account] },
  ],
}));

vi.mock("@/lib/parse-line", () => ({
  parseLine: () => null,
  classifyError: (line: string) => (line.includes("login") ? "auth" : null),
}));

const storeHooks = vi.hoisted(() => ({
  /**
   * Runs inside the mocked `saveRun`, before the real write. Tests use it to hold a status write
   * open or to make the write fail without touching the file system.
   */
  beforeSave: undefined as
    | undefined
    | ((run: { id: string; status: string; stepIndex: number }) => Promise<void> | void),
}));

vi.mock("@/server/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/store")>();
  return {
    ...actual,
    pruneRuns: vi.fn(actual.pruneRuns),
    saveRun: vi.fn(async (run: Parameters<typeof actual.saveRun>[0]) => {
      await storeHooks.beforeSave?.(run);
      await actual.saveRun(run);
    }),
  };
});

let sandbox = "";
let queueModule: typeof import("@/server/run-queue");
let storeModule: typeof import("@/server/store");

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-queue-"));
  const home = join(sandbox, "boot-home");
  await mkdir(home, { recursive: true });
  process.env.GATHER_HOME = home;
  // The singleton runs markInterrupted on import, so GATHER_HOME must point into the sandbox first.
  queueModule = await import("@/server/run-queue");
  storeModule = await import("@/server/store");
});

beforeEach(() => {
  vi.mocked(storeModule.pruneRuns).mockClear();
  storeHooks.beforeSave = undefined;
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(sandbox, "case-"));
}

function isolationHome(): void {
  process.env.GATHER_HOME = join(sandbox, `home-${Math.random().toString(36).slice(2)}`);
}

function settings(mediaRoot: string, overrides: Partial<Settings> = {}): Settings {
  return {
    galleryDlPath: "fake-gallery-dl.exe",
    mediaRoot,
    cookies: { browser: "firefox" },
    defaultMedia: "all",
    defaultLayout: { kind: "byType" },
    historyRetention: 200,
    concurrency: 1,
    schedule: { enabled: false, frequency: { kind: "daily", time: "03:00" } },
    pausedAccounts: [],
    ...overrides,
  };
}

function spec(account: string, folder?: string): JobSpec {
  return {
    site: "x",
    account,
    ...(folder ? { folder } : {}),
    media: "all",
    layout: { kind: "byType" },
    simulate: false,
    advanced: {
      imageSize: "orig",
      retweets: false,
      replies: false,
      writeMetadata: false,
      noSkip: false,
      cookies: { browser: "firefox" },
    },
  };
}

function makeQueue(mediaRoot: string, start: StartProcess, extra: Partial<Settings> = {}): RunQueueClass {
  return new queueModule.RunQueue({
    getSettings: async () => settings(mediaRoot, extra),
    startProcess: start,
  });
}

function runFor(account: string, status: RunStatus): Run {
  return {
    id: `2026-11-11T09-00-00_${account}`,
    spec: spec(account),
    steps: [],
    status,
    stepIndex: 0,
    counts: { saved: 0, skipped: 0, failed: 0 },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("timed out waiting for the queue");
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error("timed out waiting for the queue");
}

interface ControlledProcess {
  start: StartProcess;
  calls: { argv: string[]; cwd: string }[];
  resolveNext: (result: { exitCode: number | null; spawnError?: string }) => void;
}

function controlledProcess(): ControlledProcess {
  const resolvers: Array<(result: { exitCode: number | null; spawnError?: string }) => void> = [];
  const calls: { argv: string[]; cwd: string }[] = [];
  const start: StartProcess = (options) => {
    calls.push({ argv: options.argv, cwd: options.cwd });
    let resolve!: (result: { exitCode: number | null; spawnError?: string }) => void;
    const done = new Promise<{ exitCode: number | null; spawnError?: string }>((settle) => {
      resolve = settle;
    });
    resolvers.push(resolve);
    return {
      pid: 1000 + resolvers.length,
      done,
      stop: async () => {
        resolve({ exitCode: null });
      },
    };
  };
  return {
    start,
    calls,
    resolveNext: (result) => {
      const next = resolvers.shift();
      if (!next) throw new Error("no pending process to resolve");
      next(result);
    },
  };
}

describe("canStart", () => {
  const table: Array<{ running: string[]; limit: number; expected: boolean }> = [
    { running: [], limit: 1, expected: true },
    { running: ["other"], limit: 1, expected: false },
    { running: ["other"], limit: 2, expected: true },
    { running: ["username"], limit: 3, expected: false },
    { running: ["a", "b"], limit: 2, expected: false },
    { running: ["a", "b"], limit: 3, expected: true },
  ];

  for (const row of table) {
    it(`with ${row.running.length} running and limit ${row.limit} → ${row.expected}`, () => {
      const running = row.running.map((account) => runFor(account, "running"));
      expect(queueModule.canStart(runFor("username", "queued"), running, row.limit)).toBe(
        row.expected,
      );
    });
  }
});

describe("RunQueue", () => {
  it("runs the steps in order, accumulates counts and persists the run", async () => {
    isolationHome();
    const media = await tempDir();
    await mkdir(join(media, "username"), { recursive: true });

    const batches: RunEvent[][] = [
      [
        { t: "file", kind: "saved", path: "Image/a.jpg" },
        { t: "file", kind: "skipped", path: "Image/b.jpg" },
        { t: "log", level: "error", line: "[twitter][error] boom" },
      ],
      [{ t: "file", kind: "saved", path: "Video/c.mp4" }],
    ];
    let call = 0;
    const start: StartProcess = (options) => {
      options.onRaw("stdout", "gallery-dl line");
      const batch = batches[call] ?? [];
      call += 1;
      for (const event of batch) options.onEvent(event);
      return { pid: 10 + call, done: Promise.resolve({ exitCode: 0 }), stop: async () => {} };
    };

    const queue = makeQueue(media, start);
    const enqueued = await queue.enqueue(spec("username"));
    await waitFor(() => queue.get(enqueued.id)?.status === "done");
    // The queue marks the run done in memory before the final record write lands.
    await waitUntil(async () => (await storeModule.getRun(enqueued.id))?.status === "done");

    const run = queue.get(enqueued.id);
    expect(run).toBeDefined();
    expect(run?.steps).toHaveLength(2);
    expect(run?.stepIndex).toBe(1);
    expect(run?.counts).toEqual({ saved: 2, skipped: 1, failed: 1 });
    expect(run?.exitCode).toBe(0);
    expect(run?.endedAt).toBeTruthy();

    const snapshot = queue.snapshot(enqueued.id);
    expect(snapshot).toBeDefined();
    expect(snapshot?.run.status).toBe("done");
    expect(snapshot?.events.at(-1)).toEqual({ t: "status", status: "done", stepIndex: 1 });
    expect(snapshot?.events).toContainEqual({ t: "counts", saved: 2, skipped: 1, failed: 1 });

    const stored = await storeModule.getRun(enqueued.id);
    expect(stored?.status).toBe("done");
    expect(stored?.counts).toEqual({ saved: 2, skipped: 1, failed: 1 });

    const log = await storeModule.readLogTail(enqueued.id);
    expect(log.text).toContain("gallery-dl line");
  });

  it("locks one run per account and honours the global limit", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    const first = await queue.enqueue(spec("username"));
    const statuses: Array<{ status: RunStatus; stepIndex: number }> = [];
    const unsubscribe = queue.subscribe(first.id, (event) => {
      if (event.t === "status") statuses.push({ status: event.status, stepIndex: event.stepIndex });
    });

    expect(queue.get(first.id)?.status).toBe("running");
    expect(queue.list().map((run) => run.id)).toEqual([first.id]);
    expect(controlled.calls).toHaveLength(1);
    expect(controlled.calls[0]?.argv).toEqual(["images", "username"]);
    expect(controlled.calls[0]?.cwd).toBe(media);

    const second = await queue.enqueue(spec("username"));
    expect(second.id).not.toBe(first.id);
    expect(queue.get(second.id)?.status).toBe("queued");
    expect(queue.queuePosition(second.id)).toBe(1);
    expect(queue.findActive("username")?.id).toBe(first.id);

    const third = await queue.enqueue(spec("other"));
    expect(queue.get(third.id)?.status).toBe("queued");
    expect(queue.queuePosition(third.id)).toBe(2);
    expect(controlled.calls).toHaveLength(1);

    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => controlled.calls.length === 2);
    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => queue.get(first.id)?.status === "done");
    await waitFor(() => queue.get(second.id)?.status === "running");
    unsubscribe();

    expect(statuses).toEqual([
      { status: "running", stepIndex: 1 },
      { status: "done", stepIndex: 1 },
    ]);
    expect(queue.queuePosition(second.id)).toBe(0);
    expect(queue.list().map((run) => run.id)).toEqual([second.id, third.id]);
    expect(queue.get(third.id)?.status).toBe("queued");

    expect(await queue.stop(third.id)).toBe(true);
    expect(queue.get(third.id)?.status).toBe("stopped");
    expect((await storeModule.getRun(third.id))?.status).toBe("stopped");
    expect(await queue.stop(third.id)).toBe(false);

    const seen: RunStatus[] = [];
    queue.subscribe(second.id, (event) => {
      if (event.t === "status") seen.push(event.status);
    });
    expect(await queue.stop(second.id)).toBe(true);
    expect(seen).toContain("stopping");
    expect(seen.at(-1)).toBe("stopped");
    expect(queue.get(second.id)?.status).toBe("stopped");
  });

  it("records a scheduled run and makes it wait for a manual run on the same account", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    const manual = await queue.enqueue(spec("username"));
    expect(queue.get(manual.id)?.scheduled).toBeUndefined();

    const scheduled = await queue.enqueue(spec("username"), { scheduled: true });
    expect(queue.get(scheduled.id)?.scheduled).toBe(true);
    expect(queue.get(scheduled.id)?.status).toBe("queued");
    expect(queue.findActive("username")?.id).toBe(manual.id);
    expect(controlled.calls).toHaveLength(1);

    const settled = queue.waitFor(scheduled.id);
    // The manual run finishes its two steps, then the scheduled one starts.
    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => controlled.calls.length === 2);
    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => queue.get(scheduled.id)?.status === "running");
    expect(controlled.calls).toHaveLength(3);

    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => controlled.calls.length === 4);
    controlled.resolveNext({ exitCode: 0 });
    const done = await settled;
    expect(done?.status).toBe("done");
    expect(done?.scheduled).toBe(true);
    expect((await storeModule.getRun(scheduled.id))?.scheduled).toBe(true);

    // A finished run resolves at once, and an unknown id resolves empty instead of hanging.
    expect((await queue.waitFor(scheduled.id))?.status).toBe("done");
    expect(await queue.waitFor("2026-11-11T09-00-00_missing")).toBeUndefined();
  });

  it("gives two runs started in the same second distinct ids", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    const [first, second] = await Promise.all([
      queue.enqueue(spec("username")),
      queue.enqueue(spec("username")),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(await storeModule.listRuns()).toHaveLength(2);
    expect((await storeModule.getRun(first.id))?.id).toBe(first.id);
    expect((await storeModule.getRun(second.id))?.id).toBe(second.id);

    await queue.stop(second.id);
    await queue.stop(first.id);
  });

  it("starts runs of different folders in the order they were requested, not by folder name", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    await queue.enqueue(spec("busy_acct"));
    await waitFor(() => controlled.calls.length === 1);
    const zeta = await queue.enqueue(spec("zeta"));
    const alpha = await queue.enqueue(spec("alpha"));
    expect(queue.queuePosition(zeta.id)).toBe(1);
    expect(queue.queuePosition(alpha.id)).toBe(2);

    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => controlled.calls.length === 2);
    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => queue.get(zeta.id)?.status === "running");
    expect(queue.get(alpha.id)?.status).toBe("queued");

    await queue.stop(alpha.id);
    await queue.stop(zeta.id);
  });

  it("keeps the requested order when overlapping enqueues finish saving in reverse", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    await queue.enqueue(spec("busy_acct"));
    await waitFor(() => controlled.calls.length === 1);

    let releaseZeta: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseZeta = resolve;
    });
    let zetaSaving: () => void = () => {};
    const saving = new Promise<void>((resolve) => {
      zetaSaving = resolve;
    });
    storeHooks.beforeSave = async (run) => {
      if (run.id.endsWith("_zeta") && run.status === "queued") {
        zetaSaving();
        await held;
      }
    };

    const zetaRequest = queue.enqueue(spec("zeta"));
    await saving;
    const alpha = await queue.enqueue(spec("alpha"));
    releaseZeta();
    const zeta = await zetaRequest;
    storeHooks.beforeSave = undefined;

    expect(queue.queuePosition(zeta.id)).toBe(1);
    expect(queue.queuePosition(alpha.id)).toBe(2);

    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => controlled.calls.length === 2);
    controlled.resolveNext({ exitCode: 0 });
    await waitFor(() => queue.get(zeta.id)?.status === "running");
    expect(queue.get(alpha.id)?.status).toBe("queued");

    await queue.stop(alpha.id);
    await queue.stop(zeta.id);
  });

  it("stops active runs on shutdown and starts no queued run afterwards", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = new queueModule.RunQueue({
      getSettings: async () => settings(media, { concurrency: 1 }),
      startProcess: controlled.start,
    });

    const first = await queue.enqueue(spec("first_acct"));
    const second = await queue.enqueue(spec("second_acct"));
    expect(queue.get(second.id)?.status).toBe("queued");

    await queue.shutdown();

    expect(queue.get(first.id)?.status).toBe("stopped");
    expect(queue.get(second.id)?.status).toBe("queued");
    expect(controlled.calls).toHaveLength(1);
  });

  it("starts waiting runs when the concurrency limit is raised", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    let limit = 1;
    const queue = new queueModule.RunQueue({
      getSettings: async () => settings(media, { concurrency: limit }),
      startProcess: controlled.start,
    });

    const first = await queue.enqueue(spec("first_acct"));
    const second = await queue.enqueue(spec("second_acct"));
    expect(queue.get(second.id)?.status).toBe("queued");

    limit = 2;
    await queue.resume();
    await waitFor(() => queue.get(second.id)?.status === "running");

    await queue.stop(second.id);
    await queue.stop(first.id);
  });

  it("keeps ids distinct when both enqueues are still saving their records", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    // Neither run is registered in the queue while its record is being written, so the id has to be
    // claimed by the reservation, not by `runs` or the file already existing.
    const saving: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothSaving: () => void = () => {};
    const both = new Promise<void>((resolve) => {
      bothSaving = resolve;
    });
    storeHooks.beforeSave = async (run) => {
      if (run.status !== "queued") return;
      saving.push(run.id);
      if (saving.length === 2) bothSaving();
      await gate;
    };

    const pending = [queue.enqueue(spec("username")), queue.enqueue(spec("username"))];
    await both;
    release();
    const [first, second] = await Promise.all(pending);
    storeHooks.beforeSave = undefined;

    expect([...saving].sort()).toEqual([first.id, second.id].sort());
    expect(first.id).not.toBe(second.id);
    expect(await storeModule.listRuns()).toHaveLength(2);

    await queue.stop(second.id);
    await queue.stop(first.id);
  });

  it("starts no second step when Stop lands while the step-2 status is being saved", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    let releaseSave: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    storeHooks.beforeSave = async (run) => {
      if (run.status === "running" && run.stepIndex === 1) {
        saveStarted();
        await held;
      }
    };

    const run = await queue.enqueue(spec("username"));
    await waitFor(() => controlled.calls.length === 1);
    controlled.resolveNext({ exitCode: 0 });
    await started;

    const stopping = queue.stop(run.id);
    // Let stop() mark the request before the held write finishes; the flag is what must win.
    await delay(10);
    releaseSave();
    expect(await stopping).toBe(true);
    storeHooks.beforeSave = undefined;

    expect(controlled.calls).toHaveLength(1);
    expect(queue.get(run.id)?.status).toBe("stopped");
    expect((await storeModule.getRun(run.id))?.status).toBe("stopped");
  });

  it("stops a run whose Stop arrives while the first status write is still open", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    let releaseSave: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    let firstStatusSave = true;
    let heldRunId = "";
    storeHooks.beforeSave = async (run) => {
      if (firstStatusSave && run.status === "running") {
        firstStatusSave = false;
        heldRunId = run.id;
        saveStarted();
        await held;
      }
    };

    const enqueued = queue.enqueue(spec("username"));
    await started;
    // Stop arrives while the "running" record is still being written and no process exists yet.
    const stopping = queue.stop(heldRunId);
    await delay(10);
    releaseSave();
    const run = await enqueued;
    storeHooks.beforeSave = undefined;

    // The Stop waited for the real stop instead of resolving against a placeholder promise.
    expect(await stopping).toBe(true);
    expect(run.id).toBe(heldRunId);
    expect(controlled.calls).toHaveLength(0);
    expect(queue.get(run.id)?.status).toBe("stopped");
    expect((await storeModule.getRun(run.id))?.status).toBe("stopped");
  });

  it("leaves no run in memory when its record cannot be saved", async () => {
    isolationHome();
    const media = await tempDir();
    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);

    let attemptedId = "";
    storeHooks.beforeSave = (run) => {
      attemptedId = run.id;
      throw new Error("EPERM: operation not permitted, rename");
    };

    await expect(queue.enqueue(spec("username"))).rejects.toThrow(/EPERM/);
    storeHooks.beforeSave = undefined;

    expect(attemptedId).not.toBe("");
    expect(queue.get(attemptedId)).toBeUndefined();
    expect(queue.snapshot(attemptedId)).toBeUndefined();
    expect(queue.list()).toEqual([]);
    expect(await storeModule.listRuns()).toEqual([]);
    expect(controlled.calls).toHaveLength(0);

    // A later enqueue must not resurrect the run that the user was told could not start.
    const next = await queue.enqueue(spec("other"));
    await waitFor(() => controlled.calls.length === 1);
    expect(controlled.calls.map((call) => call.argv)).toEqual([["images", "other"]]);
    expect(queue.list().map((run) => run.id)).toEqual([next.id]);
    expect(await queue.stop(next.id)).toBe(true);
  });

  it("sweeps .part files when a run is stopped", async () => {
    isolationHome();
    const media = await tempDir();
    const accountDir = join(media, "username");
    await mkdir(join(accountDir, "Image"), { recursive: true });
    await writeFile(join(accountDir, "Image", "a.jpg.part"), "x");
    await writeFile(join(accountDir, "Image", "b.jpg.part-Frag3"), "x");
    await writeFile(join(accountDir, "Image", "keep.jpg"), "x");

    const controlled = controlledProcess();
    const queue = makeQueue(media, controlled.start);
    const run = await queue.enqueue(spec("username"));
    await waitFor(() => controlled.calls.length === 1);

    expect(await queue.stop(run.id)).toBe(true);
    expect(queue.get(run.id)?.status).toBe("stopped");
    expect(queue.get(run.id)?.endedAt).toBeTruthy();
    expect(await readdir(join(accountDir, "Image"))).toEqual(["keep.jpg"]);
  });

  it("marks a run failed when the exe is missing", async () => {
    isolationHome();
    const media = await tempDir();
    const start: StartProcess = () => ({
      pid: undefined,
      done: Promise.resolve({ exitCode: null, spawnError: "ENOENT" }),
      stop: async () => {},
    });
    const queue = makeQueue(media, start);
    const run = await queue.enqueue(spec("username"));
    await waitFor(() => queue.get(run.id)?.status === "failed");
    expect(queue.get(run.id)?.errorKind).toBe("binaryMissing");
  });

  it("classifies an error line when a step exits non-zero and skips the rest", async () => {
    isolationHome();
    const media = await tempDir();
    const start: StartProcess = (options) => {
      options.onEvent({ t: "log", level: "error", line: "[twitter][error] login required" });
      return { pid: 5, done: Promise.resolve({ exitCode: 1 }), stop: async () => {} };
    };
    const queue = makeQueue(media, start);
    const run = await queue.enqueue(spec("username"));
    await waitFor(() => queue.get(run.id)?.status === "failed");
    expect(queue.get(run.id)?.errorKind).toBe("auth");
    expect(queue.get(run.id)?.counts.failed).toBe(1);
    expect(queue.get(run.id)?.stepIndex).toBe(0);
  });

  it("marks leftover runs interrupted on startup and sweeps their folders", async () => {
    isolationHome();
    const media = await tempDir();
    const imageDir = join(media, "username", "Image");
    await mkdir(imageDir, { recursive: true });
    await writeFile(join(imageDir, "x.jpg.part"), "x");

    const running = runFor("username", "running");
    const queued = runFor("other_account", "queued");
    const gone = runFor("deleted_account", "running");
    await storeModule.saveRun(running);
    await storeModule.saveRun(queued);
    await storeModule.saveRun(gone);

    const queue = new queueModule.RunQueue({
      getSettings: async () => settings(media),
      startProcess: () => ({
        pid: 1,
        done: Promise.resolve({ exitCode: 0 }),
        stop: async () => {},
      }),
    });
    await queue.whenReady();

    expect((await storeModule.getRun(running.id))?.status).toBe("interrupted");
    expect((await storeModule.getRun(queued.id))?.status).toBe("interrupted");
    expect((await storeModule.getRun(gone.id))?.status).toBe("interrupted");
    expect(await readdir(imageDir)).toEqual([]);
    expect(queue.list()).toEqual([]);
  });

  it("leaves the runs of another live process alone", async () => {
    isolationHome();
    const media = await tempDir();
    const imageDir = join(media, "username", "Image");
    await mkdir(imageDir, { recursive: true });
    await writeFile(join(imageDir, "x.jpg.part"), "x");

    const running = runFor("username", "running");
    await storeModule.saveRun(running);
    await writeFile(join(process.env.GATHER_HOME ?? "", "queue.lock"), `${process.ppid}\n`, "utf8");

    const queue = new queueModule.RunQueue({
      getSettings: async () => settings(media),
      startProcess: () => ({
        pid: 1,
        done: Promise.resolve({ exitCode: 0 }),
        stop: async () => {},
      }),
    });
    await queue.whenReady();

    expect((await storeModule.getRun(running.id))?.status).toBe("running");
    expect(await readdir(imageDir)).toEqual(["x.jpg.part"]);
  });

  it("prunes history after a run finishes", async () => {
    isolationHome();
    const media = await tempDir();
    for (let hour = 0; hour < 12; hour += 1) {
      const stamp = `2026-11-01T${String(hour).padStart(2, "0")}-00-00_old`;
      await storeModule.saveRun({
        ...runFor("old", "done"),
        id: stamp,
        startedAt: `2026-11-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
      });
    }

    const queue = makeQueue(
      media,
      () => ({ pid: 1, done: Promise.resolve({ exitCode: 0 }), stop: async () => {} }),
      { historyRetention: 10 },
    );
    const run = await queue.enqueue(spec("username"));
    await waitFor(() => queue.get(run.id)?.status === "done");
    await waitFor(() => vi.mocked(storeModule.pruneRuns).mock.calls.length > 0);

    expect(storeModule.pruneRuns).toHaveBeenCalledWith(10);
    await waitUntil(
      async () => (await storeModule.listRuns(Number.MAX_SAFE_INTEGER)).length <= 10,
    );
    expect((await storeModule.listRuns(Number.MAX_SAFE_INTEGER)).length).toBe(10);
  });
});
