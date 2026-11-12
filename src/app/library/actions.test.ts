import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, JobSpec, LibraryEntry, Run, RunStatus, Settings } from "@/lib/spec";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn<(spec: JobSpec) => Promise<Run>>(),
  findActive: vi.fn<(folder: string) => Run | undefined>(),
  listAccounts: vi.fn<() => Promise<LibraryEntry[]>>(),
  moveAccountFolder: vi.fn<(from: string, to: string) => Promise<void>>(),
  getSettings: vi.fn<() => Promise<Settings>>(),
  listRuns: vi.fn<(limit?: number) => Promise<Run[]>>(),
  revalidatePath: vi.fn<(path: string) => void>(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/library", () => ({
  listAccounts: mocks.listAccounts,
  moveAccountFolder: mocks.moveAccountFolder,
}));
vi.mock("@/server/run-queue", () => ({
  runQueue: { enqueue: mocks.enqueue, findActive: mocks.findActive },
}));
vi.mock("@/server/store", () => ({
  getSettings: mocks.getSettings,
  listRuns: mocks.listRuns,
}));

import { moveAccount, updateAccount, updateAll } from "@/app/library/actions";

const SETTINGS: Settings = {
  galleryDlPath: "C:\\tools\\gallery-dl.exe",
  mediaRoot: "D:\\Photos\\p\\scrapper",
  cookies: { browser: "firefox", profile: "a1b2c3d4.default-release" },
  defaultMedia: "all",
  defaultLayout: { kind: "byType" },
  historyRetention: 200,
  concurrency: 1,
  schedule: { enabled: false, frequency: { kind: "daily", time: "03:00" } },
  pausedAccounts: [],
  closeToTray: true,
};

function specFor(account: string, overrides: Partial<JobSpec> = {}): JobSpec {
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
    ...overrides,
  };
}

function runFor(spec: JobSpec, id = `2026-11-11T09-00-00_${spec.account}`, status: RunStatus = "queued"): Run {
  return {
    id,
    spec,
    steps: [],
    status,
    stepIndex: 0,
    counts: { saved: 0, skipped: 0, failed: 0 },
  };
}

function entry(folder: string, layout: LibraryEntry["layout"] = "byType"): LibraryEntry {
  return { folder, layout };
}

function okData<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.data;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 50 && !predicate(); tick += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mocks.enqueue.mockReset();
  mocks.findActive.mockReset();
  mocks.listAccounts.mockReset();
  mocks.getSettings.mockReset();
  mocks.listRuns.mockReset();
  mocks.revalidatePath.mockReset();

  mocks.getSettings.mockResolvedValue(SETTINGS);
  mocks.listAccounts.mockResolvedValue([]);
  mocks.listRuns.mockResolvedValue([]);
  mocks.findActive.mockReturnValue(undefined);
  mocks.enqueue.mockImplementation(async (spec) => runFor(spec));
  mocks.moveAccountFolder.mockResolvedValue(undefined);
});

describe("updateAll", () => {
  it("reads the library once and queues every folder in sorted order", async () => {
    mocks.listAccounts.mockResolvedValue([entry("bob"), entry("username"), entry("alice")]);
    mocks.listRuns.mockResolvedValue([
      runFor(specFor("bob"), "2026-11-10T09-00-00_bob", "done"),
      runFor(specFor("username"), "2026-11-10T10-00-00_username", "done"),
      runFor(specFor("alice"), "2026-11-10T11-00-00_alice", "done"),
    ]);

    const result = await updateAll();

    expect(result).toEqual({ ok: true, data: { started: 3, skipped: [], assumed: [] } });
    expect(mocks.getSettings).toHaveBeenCalledTimes(1);
    expect(mocks.listAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.listRuns).toHaveBeenCalledTimes(1);
    expect(mocks.listRuns).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
    expect(mocks.enqueue.mock.calls.map(([spec]) => spec.account)).toEqual([
      "alice",
      "bob",
      "username",
    ]);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/history");
  });

  it("skips a folder that already has an active run instead of queueing a duplicate", async () => {
    mocks.listAccounts.mockResolvedValue([entry("username")]);
    mocks.findActive.mockImplementation((folder) =>
      folder === "username" ? runFor(specFor("username"), "2026-11-11T09-00-00_username", "running") : undefined,
    );

    const result = await updateAll();

    expect(result).toEqual({
      ok: true,
      data: { started: 0, skipped: [{ folder: "username", reason: "already running" }], assumed: [] },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a running folder as running even when its site could not be guessed", async () => {
    mocks.listAccounts.mockResolvedValue([entry("john.doe")]);
    mocks.findActive.mockReturnValue(runFor(specFor("john.doe"), "2026-11-11T09-00-00_john.doe", "running"));

    const result = await updateAll();

    expect(okData(result).skipped).toEqual([{ folder: "john.doe", reason: "already running" }]);
  });

  it("refuses a folder it cannot place on X and still queues the others", async () => {
    mocks.listAccounts.mockResolvedValue([entry("john.doe"), entry("alice", "byTypeYear")]);

    const result = await updateAll();
    const data = okData(result);

    expect(data.started).toBe(1);
    expect(data.assumed).toEqual(["alice"]);
    expect(data.skipped).toEqual([
      {
        folder: "john.doe",
        reason: "gather doesn't know which site john.doe came from. Run it once from the Run page first.",
      },
    ]);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const queued = mocks.enqueue.mock.calls[0][0];
    expect(queued.site).toBe("x");
    expect(queued.account).toBe("alice");
    expect(queued.layout).toEqual({ kind: "byTypeYear" });
  });

  it("keeps going when one folder's enqueue fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.listAccounts.mockResolvedValue([entry("a_one"), entry("b_two")]);
    mocks.enqueue.mockImplementation(async (spec) => {
      if (spec.account === "a_one") throw new Error("disk is full");
      return runFor(spec);
    });

    const result = await updateAll();
    errors.mockRestore();

    expect(result).toEqual({
      ok: true,
      data: {
        started: 1,
        skipped: [{ folder: "a_one", reason: "The update couldn't be started." }],
        assumed: ["b_two"],
      },
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
  });
});

describe("moveAccount", () => {
  it("renames a folder and revalidates the library page", async () => {
    const result = await moveAccount("old_name", "new_name ");

    expect(result).toEqual({ ok: true, data: { folder: "new_name" } });
    expect(mocks.moveAccountFolder).toHaveBeenCalledWith("old_name", "new_name");
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/library");
  });

  it("returns the library's refusal message as-is", async () => {
    mocks.moveAccountFolder.mockRejectedValue(
      new Error('"new_name" already exists. Choose a different folder name.'),
    );

    const result = await moveAccount("old_name", "new_name");

    expect(result).toEqual({
      ok: false,
      error: '"new_name" already exists. Choose a different folder name.',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reserves either folder while a move is in flight", async () => {
    const pending: Array<() => void> = [];
    mocks.moveAccountFolder.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    );

    const first = moveAccount("old_name", "new_name");
    await until(() => pending.length === 1);
    const second = await moveAccount("other", "new_name");
    const third = await moveAccount("new_name", "back");

    expect(second).toEqual({ ok: false, error: "A move for one of these folders is already running." });
    expect(third).toEqual({ ok: false, error: "A move for one of these folders is already running." });
    expect(mocks.moveAccountFolder).toHaveBeenCalledTimes(1);

    pending[0]();
    expect(await first).toEqual({ ok: true, data: { folder: "new_name" } });
  });

  it("refuses a non-string folder name", async () => {
    const result = await moveAccount(42 as unknown as string, "new_name");

    expect(result).toEqual({ ok: false, error: "That folder name isn't valid." });
    expect(mocks.moveAccountFolder).not.toHaveBeenCalled();
  });
});

describe("updateAccount", () => {
  it("queues the reset spec and reports the assumed X site", async () => {
    mocks.listAccounts.mockResolvedValue([entry("alice", "byTypeYear")]);

    const result = await updateAccount("alice");

    expect(okData(result)).toEqual({
      runId: "2026-11-11T09-00-00_alice",
      assumedSite: "x",
    });
    const queued = mocks.enqueue.mock.calls[0][0];
    expect(queued.site).toBe("x");
    expect(queued.simulate).toBe(false);
    expect(queued.layout).toEqual({ kind: "byTypeYear" });
    expect(queued.advanced.abortAfterSkipped).toBe(20);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/history");
  });

  it("drops the one-off limits of the last run", async () => {
    mocks.listAccounts.mockResolvedValue([entry("username")]);
    mocks.listRuns.mockResolvedValue([
      runFor(
        specFor("username", {
          simulate: false,
          dateFrom: "2025-01-01",
          dateTo: "2025-01-31",
          advanced: {
            imageSize: "orig",
            retweets: false,
            replies: true,
            writeMetadata: false,
            noSkip: true,
            range: 5,
            cookies: { browser: "firefox" },
          },
        }),
        "2026-11-10T09-00-00_username",
        "done",
      ),
    ]);

    await updateAccount("username");

    const queued = mocks.enqueue.mock.calls[0][0];
    expect(queued.simulate).toBe(false);
    expect(queued).not.toHaveProperty("dateFrom");
    expect(queued).not.toHaveProperty("dateTo");
    expect(queued.advanced).not.toHaveProperty("range");
    expect(queued.advanced.noSkip).toBe(false);
    // The last run was limited to --range 5, so "stop when caught up" would trust a partial history.
    expect(queued.advanced.abortAfterSkipped).toBeUndefined();
  });

  it("reads only the recent runs when the folder's latest run is among them", async () => {
    mocks.listAccounts.mockResolvedValue([entry("username")]);
    mocks.listRuns.mockResolvedValue([
      runFor(specFor("username", { simulate: false }), "2026-11-10T09-00-00_username", "done"),
    ]);

    await updateAccount("username");

    expect(mocks.listRuns).toHaveBeenCalledTimes(1);
    expect(mocks.listRuns).toHaveBeenCalledWith(200);
  });

  it("reads the whole history when the recent runs for the folder are only previews", async () => {
    mocks.listAccounts.mockResolvedValue([entry("username")]);
    mocks.listRuns.mockResolvedValueOnce([
      runFor(specFor("username", { simulate: true }), "2026-11-10T09-00-00_username", "done"),
    ]);

    await updateAccount("username");

    expect(mocks.listRuns).toHaveBeenCalledTimes(2);
    expect(mocks.listRuns).toHaveBeenLastCalledWith(Number.MAX_SAFE_INTEGER);
  });

  it("reads the whole history when the recent runs hold nothing for the folder", async () => {
    mocks.listAccounts.mockResolvedValue([entry("username")]);

    await updateAccount("username");

    expect(mocks.listRuns).toHaveBeenCalledTimes(2);
    expect(mocks.listRuns).toHaveBeenLastCalledWith(Number.MAX_SAFE_INTEGER);
  });

  it("refuses while that folder is already queued or running, without loading the library", async () => {
    mocks.findActive.mockReturnValue(runFor(specFor("username"), "2026-11-11T09-00-00_username", "queued"));

    const result = await updateAccount("username");

    expect(result).toEqual({
      ok: false,
      error: "An update for username is already queued or running.",
    });
    expect(mocks.listAccounts).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reports a folder that is not in the library", async () => {
    const result = await updateAccount("gone");

    expect(result).toEqual({ ok: false, error: "This account isn't in the library." });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("returns the site refusal for one folder", async () => {
    mocks.listAccounts.mockResolvedValue([entry("john.doe")]);

    const result = await updateAccount("john.doe");

    expect(result).toEqual({
      ok: false,
      error: "gather doesn't know which site john.doe came from. Run it once from the Run page first.",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reserves the folder while the first enqueue is still in flight", async () => {
    mocks.listAccounts.mockResolvedValue([entry("username")]);
    const pending: Array<(run: Run) => void> = [];
    mocks.enqueue.mockImplementation(
      () =>
        new Promise<Run>((resolve) => {
          pending.push(resolve);
        }),
    );

    const first = updateAccount("username");
    await until(() => pending.length === 1);
    const second = await updateAccount("username");

    expect(second).toEqual({
      ok: false,
      error: "An update for username is already queued or running.",
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    pending[0](runFor(specFor("username"), "2026-11-11T09-00-00_username"));
    expect(await first).toEqual({
      ok: true,
      data: { runId: "2026-11-11T09-00-00_username", assumedSite: "x" },
    });
  });
});
