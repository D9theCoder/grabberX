import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@/lib/spec";
import { getAccountHint, getAccountStats, listAccounts } from "@/server/library";
import { runQueue } from "@/server/run-queue";
import { saveSettings } from "@/server/store";

vi.mock("@/lib/sites", () => ({
  validateAccount: (_site: string, input: string) =>
    input.startsWith("bad")
      ? { ok: false, message: "X handles are 1–15 letters, numbers or _" }
      : { ok: true, account: input.replace(/^@/, "") },
  folderNameFor: (spec: { account: string; folder?: string }) =>
    spec.folder ?? spec.account.replace(/^@/, ""),
}));

vi.mock("@/server/run-queue", () => ({
  runQueue: { findActive: vi.fn() },
}));

const findActive = vi.mocked(runQueue.findActive);

let sandbox = "";
let media = "";

beforeEach(async () => {
  if (sandbox === "") sandbox = await mkdtemp(join(tmpdir(), "gather-library-"));
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "home-"));
  media = await mkdtemp(join(sandbox, "media-"));
  await saveSettings({ mediaRoot: media });
  findActive.mockReset();
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

async function touch(path: string, content = "x"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function activeRun(id: string, account: string): Run {
  return {
    id,
    spec: {
      site: "x",
      account,
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
    steps: [],
    status: "running",
    stepIndex: 0,
    counts: { saved: 0, skipped: 0, failed: 0 },
  };
}

describe("listAccounts", () => {
  it("lists top-level folders that hold an archive and detects their layout", async () => {
    await touch(join(media, "username", "archive.sqlite3"));
    await touch(join(media, "username", "Image", "a.jpg"));
    await touch(join(media, "tyearacct", "archive.sqlite3"));
    await touch(join(media, "tyearacct", "Image", "2025", "b.jpg"));
    await touch(join(media, "flatacct", "archive.sqlite3"));
    await touch(join(media, "flatacct", "c.jpg"));
    await touch(join(media, "src", "archive.sqlite3"));
    await touch(join(media, "noarchive", "Image", "d.jpg"));
    await touch(join(media, "loose-file.txt"));

    const accounts = await listAccounts();
    expect(accounts.map((entry) => entry.folder)).toEqual(["username", "flatacct", "tyearacct"]);
    const byFolder = new Map(accounts.map((entry) => [entry.folder, entry]));
    expect(byFolder.get("username")?.layout).toBe("byType");
    expect(byFolder.get("tyearacct")?.layout).toBe("byTypeYear");
    expect(byFolder.get("flatacct")?.layout).toBe("flat");
    expect(byFolder.get("username")?.lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns an empty list when the media root is gone", async () => {
    await rm(media, { recursive: true, force: true });
    expect(await listAccounts()).toEqual([]);
  });
});

describe("getAccountStats", () => {
  it("counts files and bytes under Image and Video only", async () => {
    await touch(join(media, "stats_acct", "Image", "a.jpg"), "abc");
    await touch(join(media, "stats_acct", "Image", "2025", "b.jpg"), "abcd");
    await touch(join(media, "stats_acct", "Video", "c.mp4"), "abcde");
    await touch(join(media, "stats_acct", "notes.txt"), "ignored");

    const stats = await getAccountStats("stats_acct");
    expect(stats).toEqual({ images: 2, videos: 1, bytes: 12 });
    expect(await getAccountStats("stats_acct")).toEqual(stats);
  });

  it("rejects a folder name that could escape the media root", async () => {
    await expect(getAccountStats("../escape")).rejects.toThrow();
  });
});

describe("getAccountHint", () => {
  it("is empty for a blank account", async () => {
    expect(await getAccountHint({ site: "x", account: "  " })).toEqual({ kind: "empty" });
  });

  it("is invalid when the handle fails validation", async () => {
    expect(await getAccountHint({ site: "x", account: "bad handle" })).toEqual({
      kind: "invalid",
      message: "X handles are 1–15 letters, numbers or _",
    });
  });

  it("is invalid for a folder override that is not a name", async () => {
    const hint = await getAccountHint({ site: "x", account: "username", folder: "a/b" });
    expect(hint.kind).toBe("invalid");
  });

  it("is reserved for an app folder or any dot-folder", async () => {
    expect(await getAccountHint({ site: "x", account: "src" })).toEqual({
      kind: "reserved",
      folder: "src",
    });
    expect(await getAccountHint({ site: "x", account: "username", folder: ".next" })).toEqual({
      kind: "reserved",
      folder: ".next",
    });
  });

  it("is active before it is exists", async () => {
    await touch(join(media, "username", "archive.sqlite3"));
    findActive.mockReturnValue(activeRun("2026-11-11T09-14-02_username", "username"));
    expect(await getAccountHint({ site: "x", account: "username" })).toEqual({
      kind: "active",
      runId: "2026-11-11T09-14-02_username",
    });
    expect(findActive).toHaveBeenCalledWith("username");
  });

  it("is exists for a folder with an archive, files and a layout", async () => {
    await touch(join(media, "hint_exists", "archive.sqlite3"));
    await touch(join(media, "hint_exists", "Image", "a.jpg"), "abcd");
    const archive = await stat(join(media, "hint_exists", "archive.sqlite3"));

    const hint = await getAccountHint({ site: "x", account: "hint_exists" });
    expect(hint).toEqual({
      kind: "exists",
      folder: "hint_exists",
      files: 1,
      bytes: 4,
      lastRunAt: archive.mtime.toISOString(),
      layout: "byType",
    });
  });

  it("is new for an account that is not on disk", async () => {
    expect(await getAccountHint({ site: "x", account: "new_account" })).toEqual({
      kind: "new",
      folder: "new_account",
    });
  });

  it("uses a valid folder override", async () => {
    expect(await getAccountHint({ site: "x", account: "username", folder: "renamed" })).toEqual({
      kind: "new",
      folder: "renamed",
    });
  });
});

describe("getAccountStats: layouts and cache", () => {
  it("counts a flat account by file extension and ignores the archive", async () => {
    const dir = join(media, "flat_acct");
    await touch(join(dir, "1_1.jpg"), "aaaa");
    await touch(join(dir, "2_1.mp4"), "bb");
    await touch(join(dir, "archive.sqlite3"), "db");

    await expect(getAccountStats("flat_acct")).resolves.toEqual({ images: 1, videos: 1, bytes: 6 });
  });

  it("counts a by-month account through its month folders", async () => {
    const dir = join(media, "month_acct");
    await touch(join(dir, "2025-03", "1_1.png"), "a");
    await touch(join(dir, "2025-04", "2_1.webp"), "b");

    await expect(getAccountStats("month_acct")).resolves.toMatchObject({ images: 2, videos: 0 });
  });

  it("notices a new file inside a year subfolder", async () => {
    const dir = join(media, "year_acct");
    await touch(join(dir, "Image", "2025", "1_1.jpg"));
    await expect(getAccountStats("year_acct")).resolves.toMatchObject({ images: 1 });

    // Only Image/2025 changes here; Image/ itself keeps its old mtime on most file systems.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await touch(join(dir, "Image", "2025", "2_1.jpg"));

    await expect(getAccountStats("year_acct")).resolves.toMatchObject({ images: 2 });
  });
});
