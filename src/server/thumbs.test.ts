import { mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getThumbnail, parseThumbSize, pruneThumbCache, readDimensions, thumbCacheDir, thumbKey } from "@/server/thumbs";

let sandbox = "";
let image = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-thumbs-"));
  process.env.GATHER_HOME = join(sandbox, "home");
  await mkdir(sandbox, { recursive: true });
  image = join(sandbox, "100_1.png");
  await sharp({ create: { width: 800, height: 400, channels: 3, background: "#808080" } })
    .png()
    .toFile(image);
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  await rm(sandbox, { recursive: true, force: true });
});

describe("parseThumbSize", () => {
  it("accepts only the offered sizes", () => {
    expect(parseThumbSize("240")).toBe(240);
    expect(parseThumbSize("480")).toBe(480);
    expect(parseThumbSize("100")).toBeNull();
    expect(parseThumbSize("abc")).toBeNull();
    expect(parseThumbSize(null)).toBeNull();
  });
});

describe("thumbKey", () => {
  it("changes with the file's size and modified time", () => {
    const base = thumbKey("a", 240, { size: 1, mtimeMs: 10 });
    expect(thumbKey("a", 480, { size: 1, mtimeMs: 10 })).not.toBe(base);
    expect(thumbKey("a", 240, { size: 2, mtimeMs: 10 })).not.toBe(base);
    expect(thumbKey("a", 240, { size: 1, mtimeMs: 11 })).not.toBe(base);
  });
});

describe("getThumbnail", () => {
  it("makes a smaller WebP, caches it, and reads dimensions", async () => {
    const info = await stat(image);
    const bytes = await getThumbnail(image, 240, info);
    expect(bytes).not.toBeNull();
    const meta = await sharp(bytes!).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(240);
    expect(meta.height).toBe(120);
    expect(await readdir(thumbCacheDir())).toHaveLength(1);
    expect(await getThumbnail(image, 240, info)).toEqual(bytes);
    expect(await readDimensions(image)).toEqual([800, 400]);
  });

  it("returns null for a file that is not an image", async () => {
    const bogus = join(sandbox, "bogus.jpg");
    await import("node:fs/promises").then((fs) => fs.writeFile(bogus, "not an image"));
    expect(await getThumbnail(bogus, 240, await stat(bogus))).toBeNull();
    expect(await readDimensions(bogus)).toBeNull();
  });
});

describe("pruneThumbCache", () => {
  it("removes the oldest thumbnails first once over the cap", async () => {
    const dir = thumbCacheDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "old.webp"), Buffer.alloc(100));
    await writeFile(join(dir, "new.webp"), Buffer.alloc(100));
    await utimes(join(dir, "old.webp"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    await pruneThumbCache(150);
    const left = await readdir(dir);
    expect(left).not.toContain("old.webp");
    expect(left).toContain("new.webp");
  });
});
