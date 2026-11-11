import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Run, RunStatus, Settings } from "@/lib/spec";
import {
  claimQueueLock,
  appendLog,
  getRun,
  getScheduleState,
  getSettings,
  isConfigured,
  isValidRunId,
  listRuns,
  pruneRuns,
  readLogTail,
  saveRun,
  saveScheduleState,
  saveSettings,
} from "@/server/store";

let sandbox = "";
let home = "";

beforeEach(async () => {
  if (sandbox === "") {
    sandbox = await mkdtemp(join(tmpdir(), "gather-store-"));
  }
  home = await mkdtemp(join(sandbox, "home-"));
  process.env.GATHER_HOME = home;
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

function makeRun(id: string, startedAt?: string, status: RunStatus = "done"): Run {
  return {
    id,
    spec: {
      site: "x",
      account: "username",
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
    },
    steps: [{ label: "images", argv: ["-o", "x"] }],
    status,
    stepIndex: 0,
    counts: { saved: 3, skipped: 1, failed: 0 },
    ...(startedAt ? { startedAt } : {}),
  };
}

describe("isConfigured", () => {
  it("is false until settings are saved, then true", async () => {
    expect(await isConfigured()).toBe(false);
    await saveSettings({ concurrency: 2 });
    expect(await isConfigured()).toBe(true);
  });
});

describe("getSettings", () => {
  it("takes the default paths from the environment the shell provides", async () => {
    process.env.GATHER_MEDIA_ROOT = join(sandbox, "library");
    process.env.GATHER_GALLERY_DL = join(sandbox, "bin", "gallery-dl.exe");
    try {
      const settings = await getSettings();
      expect(settings.mediaRoot).toBe(join(sandbox, "library"));
      expect(settings.galleryDlPath).toBe(join(sandbox, "bin", "gallery-dl.exe"));
    } finally {
      delete process.env.GATHER_MEDIA_ROOT;
      delete process.env.GATHER_GALLERY_DL;
    }
  });

  it("returns the documented defaults when nothing is saved", async () => {
    const settings = await getSettings();
    expect(settings.galleryDlPath).toBe("C:\\tools\\gallery-dl.exe");
    expect(settings.mediaRoot).toBe(process.cwd());
    expect(settings.cookies).toEqual({ browser: "firefox" });
    expect(settings.defaultMedia).toBe("all");
    expect(settings.defaultLayout).toEqual({ kind: "byType" });
    expect(settings.historyRetention).toBe(200);
    expect(settings.concurrency).toBe(1);
    expect(settings.schedule).toEqual({ enabled: false, frequency: { kind: "daily", time: "03:00" } });
    expect(settings.pausedAccounts).toEqual([]);
  });

  it("reads an older settings file and adds the new fields with their defaults", async () => {
    // A settings.json written before automatic updates existed: no schedule, no paused accounts.
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        galleryDlPath: "C:\\tools\\gallery-dl.exe",
        mediaRoot: "D:\\Photos\\p\\scrapper",
        cookies: { browser: "firefox" },
        defaultMedia: "images",
        defaultLayout: { kind: "byTypeYear" },
        historyRetention: 50,
        concurrency: 2,
      }),
      "utf8",
    );
    const settings = await getSettings();
    expect(settings.defaultMedia).toBe("images");
    expect(settings.concurrency).toBe(2);
    expect(settings.schedule.enabled).toBe(false);
    expect(settings.schedule.frequency).toEqual({ kind: "daily", time: "03:00" });
    expect(settings.pausedAccounts).toEqual([]);
  });

  it("keeps a saved schedule and pause list", async () => {
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        mediaRoot: "D:\\Photos\\p\\scrapper",
        schedule: { enabled: true, frequency: { kind: "everyHours", hours: 6 } },
        pausedAccounts: ["username"],
      }),
      "utf8",
    );
    const settings = await getSettings();
    expect(settings.schedule).toEqual({ enabled: true, frequency: { kind: "everyHours", hours: 6 } });
    expect(settings.pausedAccounts).toEqual(["username"]);
  });

  it("keeps the valid settings when one field is out of range", async () => {
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ mediaRoot: "D:\Photos\p\scrapper", concurrency: 5, historyRetention: 300 }),
      "utf8",
    );
    const settings = await getSettings();
    expect(settings.mediaRoot).toBe("D:\Photos\p\scrapper");
    expect(settings.historyRetention).toBe(300);
    expect(settings.concurrency).toBe(1);
  });

  it("falls back to defaults for a corrupt settings file", async () => {
    await writeFile(join(home, "settings.json"), "{ not json", "utf8");
    const settings = await getSettings();
    expect(settings.galleryDlPath).toBe("C:\\tools\\gallery-dl.exe");
  });
});

describe("saveSettings", () => {
  it("saves an unrelated field when the state folder sits inside the default media root (source layout)", async () => {
    // From source the media root is the repo root and GATHER_HOME is <repo>/.gather, by design.
    const root = join(sandbox, "source-root");
    process.env.GATHER_HOME = join(root, ".gather");
    await mkdir(root, { recursive: true });
    await saveSettings({ mediaRoot: root });
    const saved = await saveSettings({ concurrency: 2 });
    expect(saved.concurrency).toBe(2);
    expect(saved.mediaRoot).toBe(root);
  });

  it("refuses a media folder around the state folder when packaged", async () => {
    const root = join(sandbox, "packaged-root");
    await mkdir(root, { recursive: true });
    process.env.GATHER_HOME = join(root, "state");
    process.env.GATHER_PACKAGED = "1";
    process.env.GATHER_MEDIA_ROOT = join(sandbox, "library");
    process.env.GATHER_GALLERY_DL = join(sandbox, "gallery-dl.exe");
    try {
      await expect(saveSettings({ mediaRoot: root })).rejects.toThrow(/own folder/);
    } finally {
      delete process.env.GATHER_PACKAGED;
      delete process.env.GATHER_MEDIA_ROOT;
      delete process.env.GATHER_GALLERY_DL;
    }
  });

  it("merges a patch, writes atomically and reads it back", async () => {
    const saved = await saveSettings({ concurrency: 2 });
    expect(saved.concurrency).toBe(2);
    expect((await getSettings()).concurrency).toBe(2);

    const names = await readdir(home);
    expect(names).toContain("settings.json");
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps untouched fields", async () => {
    await saveSettings({ cookies: { browser: "chrome", profile: "work" } });
    const settings = await saveSettings({ defaultMedia: "images" });
    expect(settings.cookies).toEqual({ browser: "chrome", profile: "work" });
    expect(settings.defaultMedia).toBe("images");
    expect(settings.concurrency).toBe(1);
  });

  it("rejects out-of-range values with a readable message", async () => {
    await expect(saveSettings({ concurrency: 4 })).rejects.toThrow(/three runs/);
    await expect(saveSettings({ concurrency: 0 })).rejects.toThrow(/one account at a time/);
    await expect(saveSettings({ historyRetention: 5 })).rejects.toThrow(/10 runs/);
    await expect(saveSettings({ historyRetention: 5000 })).rejects.toThrow(/2000 runs/);
    await expect(saveSettings({ galleryDlPath: "  " })).rejects.toThrow(/gallery-dl/);
  });

  it("rejects a media root that does not exist", async () => {
    await expect(saveSettings({ mediaRoot: join(home, "nope") })).rejects.toThrow(/doesn't exist/);
  });

  it("rejects unknown keys instead of storing them", async () => {
    const patch = { nope: true } as unknown as Partial<Settings>;
    await expect(saveSettings(patch)).rejects.toThrow();
  });

  it("saves the schedule and validates its frequency", async () => {
    const saved = await saveSettings({
      schedule: { enabled: true, frequency: { kind: "everyHours", hours: 6 } },
    });
    expect(saved.schedule).toEqual({ enabled: true, frequency: { kind: "everyHours", hours: 6 } });
    expect((await getSettings()).schedule.enabled).toBe(true);

    const nightly = await saveSettings({
      schedule: { enabled: true, frequency: { kind: "daily", time: "21:30" } },
    });
    expect(nightly.schedule.frequency).toEqual({ kind: "daily", time: "21:30" });
  });

  it("refuses a schedule that could never run", async () => {
    await expect(
      saveSettings({ schedule: { enabled: true, frequency: { kind: "daily", time: "3am" } } }),
    ).rejects.toThrow(/time like 03:00/);
    await expect(
      saveSettings({ schedule: { enabled: true, frequency: { kind: "everyHours", hours: 0 } } }),
    ).rejects.toThrow(/every hour/);
    await expect(
      saveSettings({ schedule: { enabled: true, frequency: { kind: "everyHours", hours: 169 } } }),
    ).rejects.toThrow(/168 hours/);
    await expect(
      saveSettings({ schedule: { enabled: true, frequency: { kind: "everyHours", hours: 2.5 } } }),
    ).rejects.toThrow(/whole hours/);
  });

  it("keeps one pause per folder, trimmed and without repeats", async () => {
    const saved = await saveSettings({
      pausedAccounts: [" username ", "username", "other", "../escape"],
    });
    expect(saved.pausedAccounts).toEqual(["username", "other"]);
    expect((await getSettings()).pausedAccounts).toEqual(["username", "other"]);

    // A later save of another field leaves the pause list alone.
    await saveSettings({ concurrency: 2 });
    expect((await getSettings()).pausedAccounts).toEqual(["username", "other"]);

    expect((await saveSettings({ pausedAccounts: [] })).pausedAccounts).toEqual([]);
  });
});

describe("run records", () => {
  it("round-trips a run and leaves no temp files", async () => {
    const run = makeRun("2026-11-11T09-14-02_username", "2026-11-11T09:14:02.000Z");
    await saveRun(run);
    expect(await getRun(run.id)).toEqual(run);

    const names = await readdir(join(home, "runs"));
    expect(names).toEqual([`${run.id}.json`]);
  });

  it("returns undefined for a missing or corrupt record", async () => {
    expect(await getRun("2026-11-11T09-14-02_missing")).toBeUndefined();
    await mkdir(join(home, "runs"), { recursive: true });
    await writeFile(join(home, "runs", "2026-11-11T09-14-02_broken.json"), "{ nope", "utf8");
    await writeFile(join(home, "runs", "2026-11-11T09-14-03_shape.json"), '{"id":"x"}', "utf8");
    expect(await getRun("2026-11-11T09-14-02_broken")).toBeUndefined();
    expect(await getRun("2026-11-11T09-14-03_shape")).toBeUndefined();
  });

  it("lists newest first and skips corrupt files", async () => {
    await saveRun(makeRun("2026-11-11T09-00-00_a", "2026-11-11T09:00:00.000Z"));
    await saveRun(makeRun("2026-11-11T10-00-00_a", "2026-11-11T10:00:00.000Z"));
    await saveRun(makeRun("2026-11-11T11-00-00_a", "2026-11-11T11:00:00.000Z"));
    await writeFile(join(home, "runs", "2026-11-11T12-00-00_bad.json"), "{ nope", "utf8");

    const runs = await listRuns();
    expect(runs.map((run) => run.id)).toEqual([
      "2026-11-11T11-00-00_a",
      "2026-11-11T10-00-00_a",
      "2026-11-11T09-00-00_a",
    ]);
    expect(await listRuns(2)).toHaveLength(2);
  });

  it("rejects ids that Windows would open as a device", () => {
    for (const id of ["con", "NUL", "aux.json", "COM1", "lpt3"]) {
      expect(isValidRunId(id), id).toBe(false);
    }
    expect(isValidRunId("2026-11-11T09-00-00_console")).toBe(true);
  });

  it("rejects ids that could leave the runs folder", async () => {
    for (const id of ["../escape", "a/b", "a\\b", "..", "", "a b"]) {
      expect(isValidRunId(id), id).toBe(false);
      await expect(saveRun(makeRun(id))).rejects.toThrow();
      expect(await getRun(id)).toBeUndefined();
      await expect(appendLog(id, "x")).rejects.toThrow();
    }
    expect(await readLogTail("../escape")).toEqual({ text: "", truncated: false, totalBytes: 0 });
  });
});

describe("run logs", () => {
  it("appends and reads a small log whole", async () => {
    const id = "2026-11-11T09-14-02_username";
    await appendLog(id, "one\n");
    await appendLog(id, "two\n");
    expect(await readLogTail(id)).toEqual({ text: "one\ntwo\n", truncated: false, totalBytes: 8 });
  });

  it("reads only the end of a log longer than the cap and starts on a line boundary", async () => {
    const id = "2026-11-11T09-14-02_username";
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index} ${"x".repeat(24)}`);
    const full = `${lines.join("\n")}\n`;
    await appendLog(id, full);

    const tail = await readLogTail(id, 512);
    expect(tail.truncated).toBe(true);
    expect(tail.totalBytes).toBe(Buffer.byteLength(full));
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(512);
    // No half line at the top, and the real last line is still intact at the bottom.
    expect(tail.text.startsWith("line ")).toBe(true);
    expect(tail.text.endsWith(`${lines[lines.length - 1]}\n`)).toBe(true);
    expect(full.endsWith(tail.text)).toBe(true);
  });

  it("keeps the first line when the window starts exactly on a line boundary", async () => {
    const id = "2026-11-11T09-14-02_username";
    await appendLog(id, "old line\nkept line\n");

    const tail = await readLogTail(id, Buffer.byteLength("kept line\n"));
    expect(tail).toEqual({ text: "kept line\n", truncated: true, totalBytes: 19 });
  });

  it("shows nothing when the tail is a single line with no newline", async () => {
    const id = "2026-11-11T09-14-02_username";
    await appendLog(id, "x".repeat(1000));
    expect(await readLogTail(id, 100)).toEqual({ text: "", truncated: true, totalBytes: 1000 });
  });

  it("returns an empty tail for a missing log or an invalid id", async () => {
    const empty = { text: "", truncated: false, totalBytes: 0 };
    expect(await readLogTail("2026-11-11T09-14-02_missing")).toEqual(empty);
    expect(await readLogTail("../escape")).toEqual(empty);
  });
});

describe("history order", () => {
  it("orders by run id, so local ids and UTC startedAt cannot disagree", async () => {
    // A UTC+7 machine: the id is local time, startedAt is UTC. The old key mixed the two, so the
    // queued 20:00 record (key "…T20-00-00_q") sorted above the 23:00 run (key "…T16:00:00.000Z").
    await saveRun(makeRun("2026-11-11T08-00-00_q", undefined, "queued"));
    await saveRun(makeRun("2026-11-11T14-30-00_q", undefined, "queued"));
    await saveRun(makeRun("2026-11-11T15-00-00_a", "2026-11-11T08:00:00.000Z"));
    await saveRun(makeRun("2026-11-11T20-00-00_q", undefined, "queued"));
    await saveRun(makeRun("2026-11-11T22-00-00_a", "2026-11-11T15:00:00.000Z"));
    await saveRun(makeRun("2026-11-11T23-00-00_a", "2026-11-11T16:00:00.000Z"));

    expect((await listRuns()).map((run) => run.id)).toEqual([
      "2026-11-11T23-00-00_a",
      "2026-11-11T22-00-00_a",
      "2026-11-11T20-00-00_q",
      "2026-11-11T15-00-00_a",
      "2026-11-11T14-30-00_q",
      "2026-11-11T08-00-00_q",
    ]);
  });

  it("orders two runs of the same second by the dedupe suffix", async () => {
    await saveRun(makeRun("2026-11-11T09-00-00_a"));
    await saveRun(makeRun("2026-11-11T09-00-00_a-2"));
    expect((await listRuns()).map((run) => run.id)).toEqual([
      "2026-11-11T09-00-00_a-2",
      "2026-11-11T09-00-00_a",
    ]);
  });
});

describe("schedule state", () => {
  it("round-trips the due time the scheduler is waiting for", async () => {
    expect(await getScheduleState()).toEqual({});
    await saveScheduleState({ nextDueAt: "2026-11-13T03:00:00.000Z", frequency: "daily:03:00" });
    expect(await getScheduleState()).toEqual({
      nextDueAt: "2026-11-13T03:00:00.000Z",
      frequency: "daily:03:00",
    });
    const names = await readdir(home);
    expect(names).toContain("schedule.json");
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads a corrupt or unexpected file as no plan", async () => {
    await writeFile(join(home, "schedule.json"), "{ not json", "utf8");
    expect(await getScheduleState()).toEqual({});
    await writeFile(join(home, "schedule.json"), JSON.stringify({ nextDueAt: 42, frequency: true }), "utf8");
    expect(await getScheduleState()).toEqual({});
    await writeFile(join(home, "schedule.json"), JSON.stringify([1, 2]), "utf8");
    expect(await getScheduleState()).toEqual({});
  });

  it("marks a run as scheduled and keeps the marker on disk", async () => {
    const run: Run = { ...makeRun("2026-11-11T09-14-02_username"), scheduled: true };
    await saveRun(run);
    expect((await getRun(run.id))?.scheduled).toBe(true);
  });

  it("refuses a run record whose scheduled marker is not a boolean", async () => {
    await mkdir(join(home, "runs"), { recursive: true });
    const id = "2026-11-11T09-14-02_username";
    await writeFile(
      join(home, "runs", `${id}.json`),
      JSON.stringify({ ...makeRun(id), scheduled: "yes" }),
      "utf8",
    );
    expect(await getRun(id)).toBeUndefined();
  });
});

describe("claimQueueLock", () => {
  it("is granted when nobody holds it, and again to the same process", async () => {
    expect(await claimQueueLock()).toBe(true);
    expect(await claimQueueLock()).toBe(true);
    expect((await readFile(join(home, "queue.lock"), "utf8")).trim()).toBe(String(process.pid));
  });

  it("is refused while another live process holds it", async () => {
    await writeFile(join(home, "queue.lock"), `${process.ppid}\n`, "utf8");
    expect(await claimQueueLock()).toBe(false);
    expect((await readFile(join(home, "queue.lock"), "utf8")).trim()).toBe(String(process.ppid));
  });

  it("is taken over from a process that no longer exists", async () => {
    await writeFile(join(home, "queue.lock"), "2147483646\n", "utf8");
    expect(await claimQueueLock()).toBe(true);
    expect((await readFile(join(home, "queue.lock"), "utf8")).trim()).toBe(String(process.pid));
  });
});

describe("pruneRuns", () => {
  it("shares one pass between runs that finish together", async () => {
    for (let hour = 0; hour < 12; hour += 1) {
      await saveRun(makeRun(`2026-11-11T${String(hour).padStart(2, "0")}-00-00_a`));
    }
    const [first, second] = await Promise.all([pruneRuns(10), pruneRuns(10)]);
    expect(first).toBe(2);
    expect(second).toBe(2);
    expect(await listRuns()).toHaveLength(10);
  });

  it("keeps the newest records and deletes their logs", async () => {
    const ids: string[] = [];
    for (let hour = 0; hour < 12; hour += 1) {
      const stamp = `2026-11-11T${String(hour).padStart(2, "0")}-00-00_a`;
      ids.push(stamp);
      await saveRun(makeRun(stamp, `2026-11-11T${String(hour).padStart(2, "0")}:00:00.000Z`));
      await appendLog(stamp, "line\n");
    }

    expect(await pruneRuns(10)).toBe(2);
    const left = await listRuns();
    expect(left).toHaveLength(10);
    expect(left.map((run) => run.id)).not.toContain(ids[0]);
    await expect(stat(join(home, "runs", `${ids[0]}.log`))).rejects.toThrow();
    expect(await pruneRuns(10)).toBe(0);
  });

  it("never deletes a queued, running or stopping record", async () => {
    for (let hour = 1; hour <= 6; hour += 1) {
      const stamp = `2026-11-11T1${hour}-00-00_a`;
      await saveRun(makeRun(stamp));
    }
    // Older ids than every finished run, so only the active exemption can save them.
    const queued = makeRun("2026-11-11T00-00-00_q", undefined, "queued");
    const running = makeRun("2026-11-11T00-00-01_r", undefined, "running");
    const stopping = makeRun("2026-11-11T00-00-02_s", undefined, "stopping");
    await saveRun(queued);
    await saveRun(running);
    await saveRun(stopping);

    expect(await pruneRuns(2)).toBe(4);
    const left = (await listRuns()).map((run) => run.id);
    expect(left).toContain(queued.id);
    expect(left).toContain(running.id);
    expect(left).toContain(stopping.id);
    expect(left).toEqual([
      "2026-11-11T16-00-00_a",
      "2026-11-11T15-00-00_a",
      "2026-11-11T00-00-02_s",
      "2026-11-11T00-00-01_r",
      "2026-11-11T00-00-00_q",
    ]);
  });
});
