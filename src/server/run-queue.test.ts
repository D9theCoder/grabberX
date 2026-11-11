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

vi.mock("@/server/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/store")>();
  return { ...actual, pruneRuns: vi.fn(actual.pruneRuns) };
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

    const log = await storeModule.readLog(enqueued.id);
    expect(log).toContain("gallery-dl line");
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
