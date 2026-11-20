import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArchiveTip } from "@/server/archive";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gather-archive-"));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function makeArchive(folder: string, entries: string[]): Promise<string> {
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "archive.sqlite3");
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE archive (entry TEXT PRIMARY KEY) WITHOUT ROWID");
    const insert = db.prepare("INSERT INTO archive (entry) VALUES (?)");
    for (const entry of entries) insert.run(entry);
  } finally {
    db.close();
  }
  return file;
}

describe("readArchiveTip", () => {
  it("reads the newest Twitter post IDs numerically without modifying the archive", async () => {
    const file = await makeArchive("alice", [
      "twitter999_0_1",
      "twitter2120165612320411775_0_2",
      "twitter2120165612320411776_0_1",
      "twitter1900000000000000000_2120165612320411799_1",
    ]);
    const before = await stat(file);

    const tip = await readArchiveTip(root, "alice");

    const after = await stat(file);
    expect(tip).toEqual({
      tweetId: "2120165612320411776",
      timelineId: "2120165612320411799",
    });
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("returns undefined for non-Twitter or empty archives", async () => {
    await makeArchive("insta_acct", ["instagram4028604394690902491", "instagram4023575739228270482"]);
    await makeArchive("empty_acct", []);

    expect(await readArchiveTip(root, "insta_acct")).toBeUndefined();
    expect(await readArchiveTip(root, "empty_acct")).toBeUndefined();
  });

  it("returns undefined gracefully when the archive is missing, corrupt, or invalid", async () => {
    await mkdir(join(root, "corrupt"), { recursive: true });
    await writeFile(join(root, "corrupt", "archive.sqlite3"), "not a sqlite file", "utf8");

    expect(await readArchiveTip(root, "missing")).toBeUndefined();
    expect(await readArchiveTip(root, "corrupt")).toBeUndefined();
    expect(await readArchiveTip(root, "../escape")).toBeUndefined();
  });
});
