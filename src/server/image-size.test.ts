import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readImageSize, sizeFromHeader } from "@/server/image-size";

let sandbox = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-size-"));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function base(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "#808080" } });
}

describe("sizeFromHeader", () => {
  it("reads PNG, GIF, JPEG and every WebP flavour", async () => {
    expect(sizeFromHeader(await base(321, 123).png().toBuffer())).toEqual([321, 123]);
    expect(sizeFromHeader(await base(64, 40).gif().toBuffer())).toEqual([64, 40]);
    expect(sizeFromHeader(await base(800, 600).jpeg().toBuffer())).toEqual([800, 600]);
    expect(sizeFromHeader(await base(301, 99).webp({ quality: 50 }).toBuffer())).toEqual([301, 99]);
    expect(sizeFromHeader(await base(77, 55).webp({ lossless: true }).toBuffer())).toEqual([77, 55]);
    const withAlpha = await sharp({ create: { width: 90, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } })
      .webp({ quality: 50 })
      .toBuffer();
    expect(sizeFromHeader(withAlpha)).toEqual([90, 30]);
  });

  it("swaps the sides of a JPEG rotated by its EXIF orientation", async () => {
    const rotated = await base(400, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(sizeFromHeader(rotated)).toEqual([100, 400]);
  });

  it("returns null for anything else", () => {
    expect(sizeFromHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    expect(sizeFromHeader(new Uint8Array())).toBeNull();
  });
});

describe("readImageSize", () => {
  it("reads only the head of the file", async () => {
    const file = join(sandbox, "1_1.jpg");
    await base(1200, 900).jpeg().toFile(file);
    expect(await readImageSize(file)).toEqual([1200, 900]);
    expect(await readImageSize(join(sandbox, "missing.jpg"))).toBeNull();
  });
});
