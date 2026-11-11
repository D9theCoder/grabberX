import { mkdtemp, readdir, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Run, Settings } from "@/lib/spec";
import {
  appendLog,
  getRun,
  getSettings,
  isValidRunId,
  listRuns,
  pruneRuns,
  readLog,
  saveRun,
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

function makeRun(id: string, startedAt?: string): Run {
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
    status: "done",
    stepIndex: 0,
    counts: { saved: 3, skipped: 1, failed: 0 },
    ...(startedAt ? { startedAt } : {}),
  };
}

describe("getSettings", () => {
  it("returns the documented defaults when nothing is saved", async () => {
    const settings = await getSettings();
    expect(settings.galleryDlPath).toBe("C:\\tools\\gallery-dl.exe");
    expect(settings.mediaRoot).toBe(process.cwd());
    expect(settings.cookies).toEqual({ browser: "firefox" });
    expect(settings.defaultMedia).toBe("all");
    expect(settings.defaultLayout).toEqual({ kind: "byType" });
    expect(settings.historyRetention).toBe(200);
    expect(settings.concurrency).toBe(1);
  });

  it("falls back to defaults for a corrupt settings file", async () => {
    await writeFile(join(home, "settings.json"), "{ not json", "utf8");
    const settings = await getSettings();
    expect(settings.galleryDlPath).toBe("C:\\tools\\gallery-dl.exe");
  });
});

describe("saveSettings", () => {
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

  it("rejects ids that could leave the runs folder", async () => {
    for (const id of ["../escape", "a/b", "a\\b", "..", "", "a b"]) {
      expect(isValidRunId(id), id).toBe(false);
      await expect(saveRun(makeRun(id))).rejects.toThrow();
      expect(await getRun(id)).toBeUndefined();
      await expect(appendLog(id, "x")).rejects.toThrow();
    }
    expect(await readLog("../escape")).toBe("");
  });
});

describe("run logs", () => {
  it("appends and reads a log", async () => {
    const id = "2026-11-11T09-14-02_username";
    await appendLog(id, "one\n");
    await appendLog(id, "two\n");
    expect(await readLog(id)).toBe("one\ntwo\n");
    expect(await readLog("2026-11-11T09-14-02_missing")).toBe("");
  });
});

describe("pruneRuns", () => {
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
});
