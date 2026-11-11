import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  etagOf,
  listFolder,
  MediaPathError,
  parseRange,
  parseRelativePath,
  resolveMediaPath,
  statMediaFile,
} from "@/server/media";
import { saveSettings } from "@/server/store";

let sandbox = "";
let media = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-media-"));
  process.env.GATHER_HOME = join(sandbox, "home");
  media = join(sandbox, "library");
  await mkdir(join(media, "username", "Image", "2025"), { recursive: true });
  await mkdir(join(media, "username", "Video"), { recursive: true });
  await mkdir(join(media, "example_user", "Image"), { recursive: true });
  await mkdir(join(media, "src"), { recursive: true });
  await writeFile(join(media, "username", "Image", "2025", "100_1.jpg"), "abcdefghij");
  await writeFile(join(media, "username", "Image", "200_1.png"), "png");
  await writeFile(join(media, "username", "Image", "200_1.json"), "{}");
  await writeFile(join(media, "username", "Image", "300_1.jpg.part"), "x");
  await writeFile(join(media, "username", "Video", "400_1.mp4"), "video");
  await writeFile(join(media, "username", "archive.sqlite3"), "db");
  await writeFile(join(media, "example_user", "Image", "500_1.jpg"), "secret");
  await writeFile(join(sandbox, "outside.jpg"), "outside");
  await saveSettings({ mediaRoot: media });
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

async function rejects(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MediaPathError);
  expect((error as MediaPathError).status).toBe(status);
}

describe("parseRelativePath", () => {
  it("accepts an empty path and nested folders", () => {
    expect(parseRelativePath("")).toEqual([]);
    expect(parseRelativePath("Image/2025/100_1.jpg")).toEqual(["Image", "2025", "100_1.jpg"]);
  });

  it.each([
    "..",
    "../example_user/Image/500_1.jpg",
    "Image/../../outside.jpg",
    "Image/./100_1.jpg",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "C:\\Windows\\win.ini",
    "Image\\100_1.jpg",
    "Image//100_1.jpg",
    "Image/",
    ".gather/settings.json",
    "Image/con.jpg",
    "Image/file:stream.jpg",
    "Image/a*.jpg",
    "Image/100_1.jpg.",
    "\\\\server\\share\\x.jpg",
  ])("rejects %s", (raw) => {
    expect(() => parseRelativePath(raw)).toThrow(MediaPathError);
  });
});

describe("resolveMediaPath", () => {
  it("resolves a file inside the account", async () => {
    const result = await resolveMediaPath(media, "username", "Image/2025/100_1.jpg");
    expect(result.full).toBe(resolve(media, "username", "Image", "2025", "100_1.jpg"));
  });

  it("rejects reserved and invalid accounts", async () => {
    await rejects(resolveMediaPath(media, "src", ""), 400);
    await rejects(resolveMediaPath(media, ".gather", ""), 400);
    await rejects(resolveMediaPath(media, "..", "x.jpg"), 400);
    await rejects(resolveMediaPath(media, "user/name", ""), 400);
    await rejects(resolveMediaPath(media, "C:", ""), 400);
    await rejects(resolveMediaPath(media, "", ""), 400);
  });

  it("never reaches another account or the media root", async () => {
    await rejects(resolveMediaPath(media, "username", "../example_user/Image/500_1.jpg"), 400);
    await rejects(resolveMediaPath(media, "username", "..%2Fexample_user"), 400);
    await rejects(resolveMediaPath(media, "username", resolve(media, "example_user", "Image", "500_1.jpg")), 400);
  });

  it("returns 404 for a missing file", async () => {
    await rejects(resolveMediaPath(media, "username", "Image/999_1.jpg"), 404);
    await rejects(resolveMediaPath(media, "nobody", ""), 404);
  });

  it("refuses a symlink that leaves the account folder", async () => {
    const link = join(media, "username", "Image", "link.jpg");
    try {
      await symlink(join(sandbox, "outside.jpg"), link, "file");
    } catch {
      return;
    }
    await rejects(resolveMediaPath(media, "username", "Image/link.jpg"), 400);
  });
});

describe("statMediaFile", () => {
  it("returns the file and its size", async () => {
    const file = await statMediaFile("username", "Image/2025/100_1.jpg");
    expect(file.name).toBe("100_1.jpg");
    expect(file.info.size).toBe(10);
  });

  it("only serves known media extensions", async () => {
    await rejects(statMediaFile("username", "archive.sqlite3"), 400);
    await rejects(statMediaFile("username", "Image/200_1.json"), 400);
    await rejects(statMediaFile("username", "Image/300_1.jpg.part"), 400);
  });

  it("refuses a folder", async () => {
    await rejects(statMediaFile("username", "Image"), 400);
  });
});

describe("listFolder", () => {
  it("lists sub-folders first and only media files", async () => {
    const listing = await listFolder("username", "Image");
    expect(listing.folders).toEqual([{ name: "2025" }]);
    expect(listing.files.map((file) => file.name)).toEqual(["200_1.png"]);
    expect(listing.files[0]).toMatchObject({ kind: "image", size: 3 });
  });

  it("lists the account folder without the archive", async () => {
    const listing = await listFolder("username", "");
    expect(listing.folders.map((folder) => folder.name).sort()).toEqual(["Image", "Video"]);
    expect(listing.files).toEqual([]);
  });

  it("marks videos", async () => {
    const listing = await listFolder("username", "Video");
    expect(listing.files).toMatchObject([{ name: "400_1.mp4", kind: "video" }]);
  });

  it("rejects traversal and missing folders", async () => {
    await rejects(listFolder("username", "../example_user"), 400);
    await rejects(listFolder("username", "Nope"), 404);
    await rejects(listFolder("username", "Image/200_1.png"), 404);
  });
});

describe("parseRange", () => {
  it("ignores an absent or malformed header", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("items=0-5", 100)).toBeNull();
    expect(parseRange("bytes=0-5,10-15", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
  });

  it("reads closed, open and suffix ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  it("clamps the end and an oversized suffix", () => {
    expect(parseRange("bytes=50-5000", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("flags unsatisfiable ranges", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=200-300", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=20-10", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1", 0)).toBe("unsatisfiable");
  });
});

describe("etagOf", () => {
  it("changes with size and modified time", () => {
    const base = etagOf({ size: 10, mtimeMs: 1000 });
    expect(etagOf({ size: 11, mtimeMs: 1000 })).not.toBe(base);
    expect(etagOf({ size: 10, mtimeMs: 2000 })).not.toBe(base);
  });
});
