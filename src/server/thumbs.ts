import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherHome } from "@/server/store";

export const THUMB_SIZES = [240, 480] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const PRUNE_EVERY = 200;

type Sharp = typeof import("sharp").default;

let sharpModule: Promise<Sharp | null> | null = null;

/** sharp ships native binaries. If they fail to load, thumbnails switch off and the grid scales the original. */
function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp")
    .then((module) => {
      // sharp keeps decoded files in a cache and holds their handles; on Windows that blocks deleting or moving them.
      module.default.cache(false);
      return module.default;
    })
    .catch((error: unknown) => {
      console.error("gather: sharp could not be loaded, thumbnails are off.", error);
      return null;
    });
  return sharpModule;
}

export function parseThumbSize(raw: string | null): ThumbSize | null {
  const value = Number(raw);
  return (THUMB_SIZES as readonly number[]).includes(value) ? (value as ThumbSize) : null;
}

export function thumbCacheDir(): string {
  return join(gatherHome(), "thumbs");
}

/** The key changes with the file's size and modified time, so an edited file never serves a stale thumbnail. */
export function thumbKey(fullPath: string, size: ThumbSize, file: { size: number; mtimeMs: number }): string {
  return createHash("sha1")
    .update(`${fullPath}|${size}|${file.size}|${Math.floor(file.mtimeMs)}`)
    .digest("hex");
}

let writesSincePrune = 0;

/** Deletes the oldest thumbnails once the cache is over its cap. Runs now and then, never on a read. */
export async function pruneThumbCache(limit: number = CACHE_LIMIT_BYTES): Promise<void> {
  const dir = thumbCacheDir();
  const names = await readdir(dir).catch(() => []);
  const files = (
    await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(dir, name)).catch(() => null);
        return info ? { path: join(dir, name), size: info.size, atimeMs: info.mtimeMs } : null;
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  let total = files.reduce((sum, entry) => sum + entry.size, 0);
  files.sort((a, b) => a.atimeMs - b.atimeMs);
  for (const entry of files) {
    if (total <= limit) break;
    await rm(entry.path, { force: true });
    total -= entry.size;
  }
}

/** Returns WebP bytes, or null when thumbnails are unavailable (sharp missing, or the file can't be decoded). */
export async function getThumbnail(
  fullPath: string,
  size: ThumbSize,
  file: { size: number; mtimeMs: number },
): Promise<Buffer | null> {
  const dir = thumbCacheDir();
  const cached = join(dir, `${thumbKey(fullPath, size, file)}.webp`);
  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;

  const sharp = await loadSharp();
  if (sharp === null) return null;
  let output: Buffer;
  try {
    output = await sharp(fullPath, { failOn: "none" })
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch (error) {
    console.error("gather: could not make a thumbnail.", error);
    return null;
  }

  await mkdir(dir, { recursive: true });
  const temp = `${cached}.${process.pid}.tmp`;
  await writeFile(temp, output);
  await rename(temp, cached).catch(() => rm(temp, { force: true }));
  writesSincePrune += 1;
  if (writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0;
    void pruneThumbCache().catch(() => {});
  }
  return output;
}

/** Width and height of an image from its header, without decoding it. Null for anything sharp can't read. */
export async function readDimensions(fullPath: string): Promise<[number, number] | null> {
  const sharp = await loadSharp();
  if (sharp === null) return null;
  try {
    const meta = await sharp(fullPath, { failOn: "none" }).metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    return width && height ? [width, height] : null;
  } catch {
    return null;
  }
}
