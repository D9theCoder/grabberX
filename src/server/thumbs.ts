import "server-only";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherHome } from "@/server/store";

export const THUMB_SIZES = [240, 480] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

// The warmer fills the cache ahead of time, so it needs room for a whole library of 480 px thumbnails (~30 KB each).
const CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;
const PRUNE_EVERY = 200;

type Sharp = typeof import("sharp").default;

let sharpModule: Promise<Sharp | null> | null = null;

/** sharp ships native binaries. If they fail to load, thumbnails switch off and the grid scales the original. */
function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp")
    .then((module) => {
      // sharp keeps decoded files in a cache and holds their handles; on Windows that blocks deleting or moving them.
      module.default.cache(false);
      // libvips threads per image. The gate below already runs a few images at once; more threads each only
      // starve the file reads that page loads wait on.
      module.default.concurrency(2);
      return module.default;
    })
    .catch((error: unknown) => {
      console.error("grabberX: sharp could not be loaded, thumbnails are off.", error);
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

export type Priority = "now" | "idle";

/**
 * Decoding is the expensive part. Requests from the grid ("now") always go before the background warmer
 * ("idle"), and the warmer never holds more than one slot, so a page never waits behind a warm-up.
 */
class Gate {
  private active = 0;
  private activeIdle = 0;
  private readonly waiting: { now: Array<() => void>; idle: Array<() => void> } = { now: [], idle: [] };

  constructor(private readonly limit: number) {}

  async run<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting[priority].push(resolve);
      this.pump();
    });
    try {
      return await task();
    } finally {
      this.active -= 1;
      if (priority === "idle") this.activeIdle -= 1;
      this.pump();
    }
  }

  get busy(): boolean {
    return this.active > this.activeIdle || this.waiting.now.length > 0;
  }

  private pump() {
    while (this.active < this.limit) {
      const now = this.waiting.now.shift();
      if (now) {
        this.active += 1;
        now();
        continue;
      }
      if (this.activeIdle >= 1 || this.waiting.idle.length === 0) return;
      this.active += 1;
      this.activeIdle += 1;
      this.waiting.idle.shift()!();
    }
  }
}

// The gate and in-flight map live on globalThis: Next can load this module in more than one chunk, and the
// grid and the warmer must share one gate for the warmer to step aside.
interface ThumbState {
  gate: Gate;
  inFlight: Map<string, Promise<Buffer | null>>;
  writesSincePrune: number;
}

const THUMB_STATE = Symbol.for("gather.thumbs");

function thumbState(): ThumbState {
  const holder = globalThis as unknown as Record<symbol, ThumbState | undefined>;
  return (holder[THUMB_STATE] ??= { gate: new Gate(3), inFlight: new Map(), writesSincePrune: 0 });
}

/** True while the grid is asking for thumbnails; the warmer waits. */
export function thumbnailsBusy(): boolean {
  return thumbState().gate.busy;
}

async function store(cached: string, output: Buffer) {
  await mkdir(thumbCacheDir(), { recursive: true });
  const temp = `${cached}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, output);
  await rename(temp, cached).catch(() => rm(temp, { force: true }));
  const state = thumbState();
  state.writesSincePrune += 1;
  if (state.writesSincePrune >= PRUNE_EVERY) {
    state.writesSincePrune = 0;
    void pruneThumbCache().catch(() => {});
  }
}

function cachePath(fullPath: string, size: ThumbSize, file: { size: number; mtimeMs: number }): string {
  return join(thumbCacheDir(), `${thumbKey(fullPath, size, file)}.webp`);
}

export async function hasThumbnail(fullPath: string, size: ThumbSize, file: { size: number; mtimeMs: number }) {
  return access(cachePath(fullPath, size, file)).then(
    () => true,
    () => false,
  );
}

/** A cached thumbnail only, never a new one. Video posters come from a browser capture or the ffmpeg warmer. */
export async function cachedThumbnail(fullPath: string, size: ThumbSize, file: { size: number; mtimeMs: number }) {
  return readFile(cachePath(fullPath, size, file)).catch(() => null);
}

/** True when sharp loaded; the warmer skips work that would be thrown away. */
export async function thumbnailsAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null;
}

/** Returns WebP bytes, or null when thumbnails are unavailable (sharp missing, or the file can't be decoded). */
export async function getThumbnail(
  fullPath: string,
  size: ThumbSize,
  file: { size: number; mtimeMs: number },
  priority: Priority = "now",
): Promise<Buffer | null> {
  const cached = cachePath(fullPath, size, file);
  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;

  // Two tiles (or the grid and the warmer) asking for the same thumbnail share one decode.
  const state = thumbState();
  const running = state.inFlight.get(cached);
  if (running) return running;
  const job = state.gate
    .run(priority, async () => {
      const again = await readFile(cached).catch(() => null);
      if (again) return again;
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
        console.error("grabberX: could not make a thumbnail.", error);
        return null;
      }
      await store(cached, output);
      return output;
    })
    .finally(() => state.inFlight.delete(cached));
  state.inFlight.set(cached, job);
  return job;
}

const POSTER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Stores a video's poster frame, captured by a browser or the ffmpeg warmer. The bytes are decoded and
 * re-encoded, so whatever the source sends, only a real image of at most 480 px lands in the cache. Returns
 * the stored WebP length, or null when the bytes aren't a usable image.
 */
export async function savePoster(
  fullPath: string,
  file: { size: number; mtimeMs: number },
  bytes: Uint8Array,
  priority: Priority = "now",
): Promise<number | null> {
  if (bytes.length === 0 || bytes.length > POSTER_MAX_BYTES) return null;
  const sharp = await loadSharp();
  if (sharp === null) return null;
  try {
    const output = await thumbState().gate.run(priority, () =>
      sharp(bytes, { failOn: "error", limitInputPixels: 4096 * 4096 })
        .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer(),
    );
    await store(cachePath(fullPath, 480, file), output);
    return output.length;
  } catch {
    return null;
  }
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
