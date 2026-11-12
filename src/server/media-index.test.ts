import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaFile } from "@/components/gallery/types";
import { completeMeta, knownMeta, recordDuration, resetMediaIndexMemory } from "@/server/media-index";

let sandbox = "";
let folder = "";
let files: MediaFile[] = [];

async function describeFile(name: string, kind: MediaFile["kind"]): Promise<MediaFile> {
  const info = await stat(join(folder, name));
  return { name, size: info.size, mtimeMs: info.mtimeMs, kind };
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-index-"));
  process.env.GATHER_HOME = join(sandbox, "home");
  folder = join(sandbox, "account", "Image");
  await mkdir(folder, { recursive: true });
  await sharp({ create: { width: 640, height: 480, channels: 3, background: "#808080" } }).jpeg().toFile(join(folder, "1_1.jpg"));
  await sharp({ create: { width: 300, height: 900, channels: 3, background: "#808080" } }).png().toFile(join(folder, "2_1.png"));
  await writeFile(join(folder, "3_1.mp4"), "not really a video");
  files = [await describeFile("1_1.jpg", "image"), await describeFile("2_1.png", "image"), await describeFile("3_1.mp4", "video")];
});

beforeEach(() => resetMediaIndexMemory());

afterAll(async () => {
  delete process.env.GATHER_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

describe("media index", () => {
  it("knows nothing before the first scan, then everything", async () => {
    expect(await knownMeta(folder, files)).toEqual({ dimensions: {}, durations: {}, missing: 2 });
    const meta = await completeMeta(folder, files);
    expect(meta.dimensions).toEqual({ "1_1.jpg": [640, 480], "2_1.png": [300, 900] });
    expect(meta.missing).toBe(0);
  });

  it("keeps video lengths and survives a restart through the file on disk", async () => {
    await completeMeta(folder, files);
    await recordDuration(folder, files[2]!, 42.04);
    // The save is debounced; wait for it, then forget the memory copy as a restart would.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(await readdir(join(sandbox, "home", "index"))).toHaveLength(1);
    resetMediaIndexMemory();
    const meta = await knownMeta(folder, files);
    expect(meta.durations).toEqual({ "3_1.mp4": 42 });
    expect(meta.dimensions["1_1.jpg"]).toEqual([640, 480]);
  });

  it("drops an entry once the file changes", async () => {
    await completeMeta(folder, files);
    const edited = files.map((file) => (file.name === "1_1.jpg" ? { ...file, size: file.size + 1 } : file));
    const meta = await knownMeta(folder, edited);
    expect(meta.dimensions["1_1.jpg"]).toBeUndefined();
    expect(meta.missing).toBe(1);
  });

  it("shares its memory with another module copy", async () => {
    await completeMeta(folder, files);
    await recordDuration(folder, files[2]!, 42.04);
    // The save is debounced, so the second copy can only see the length through the shared memory state.
    vi.resetModules();
    const second = await import("@/server/media-index");
    const meta = await second.knownMeta(folder, files);
    expect(meta.durations).toEqual({ "3_1.mp4": 42 });
    expect(meta.dimensions["1_1.jpg"]).toEqual([640, 480]);
  });
});
