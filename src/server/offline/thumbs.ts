import "server-only";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as osConstants, setPriority } from "node:os";
import { join } from "node:path";
import { OFFLINE_THUMB_SIZE } from "@/lib/offline";
import { runQueue } from "@/server/run-queue";
import { gatherHome } from "@/server/store";
import { cachedThumbnail } from "@/server/thumbs";
import { findFfmpeg } from "@/server/video-poster";

const CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
const PRUNE_EVERY = 200;
const CAPTURE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PAUSE_POLL_MS = 250;

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp | null> | null = null;

function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp")
    .then((module) => {
      module.default.cache(false);
      module.default.concurrency(1);
      return module.default;
    })
    .catch(() => null);
  return sharpModule;
}

export function offlineThumbCacheDir(): string {
  return join(gatherHome(), "offline-thumbs");
}

export function offlineThumbKey(fullPath: string, file: { size: number; mtimeMs: number }): string {
  return createHash("sha1")
    .update(`${fullPath}|${OFFLINE_THUMB_SIZE}|${file.size}|${Math.floor(file.mtimeMs)}`)
    .digest("hex");
}

function cachePath(fullPath: string, file: { size: number; mtimeMs: number }): string {
  return join(offlineThumbCacheDir(), `${offlineThumbKey(fullPath, file)}.webp`);
}

export function isGalleryDlRunActive(): boolean {
  return runQueue.list().some((run) => run.status === "running" || run.status === "stopping");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface OfflineThumbSchedulerDeps {
  isDownloadActive?: () => boolean;
  pollMs?: number;
}

/**
 * Low-impact thumbnail job scheduler:
 * - Strictly 1 job at a time (concurrency = 1)
 * - Deduplicates concurrent callers asking for the same key
 * - Pauses before starting any job while a gallery-dl download run is active
 */
export class OfflineThumbScheduler {
  private readonly isDownloadActive: () => boolean;
  private readonly pollMs: number;
  private readonly inFlight = new Map<string, Promise<Buffer | null>>();
  private tail: Promise<void> = Promise.resolve();
  private runningCount = 0;

  constructor(deps: OfflineThumbSchedulerDeps = {}) {
    this.isDownloadActive = deps.isDownloadActive ?? isGalleryDlRunActive;
    this.pollMs = deps.pollMs ?? PAUSE_POLL_MS;
  }

  get activeJobs(): number {
    return this.runningCount;
  }

  get paused(): boolean {
    return this.isDownloadActive();
  }

  schedule(key: string, work: () => Promise<Buffer | null>, signal?: AbortSignal): Promise<Buffer | null> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const job = this.tail
      .catch(() => {})
      .then(async () => {
        while (this.isDownloadActive()) {
          await sleep(this.pollMs, signal);
        }
        if (signal?.aborted) return null;
        this.runningCount += 1;
        try {
          return await work();
        } finally {
          this.runningCount -= 1;
        }
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, job);
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}

interface OfflineThumbState {
  scheduler: OfflineThumbScheduler;
  writesSincePrune: number;
}

const OFFLINE_THUMB_STATE = Symbol.for("gather.offline.thumbs");

function thumbState(): OfflineThumbState {
  const holder = globalThis as unknown as Record<symbol, OfflineThumbState | undefined>;
  return (holder[OFFLINE_THUMB_STATE] ??= {
    scheduler: new OfflineThumbScheduler(),
    writesSincePrune: 0,
  });
}

export function getOfflineThumbScheduler(): OfflineThumbScheduler {
  return thumbState().scheduler;
}

export async function pruneOfflineThumbCache(limit: number = CACHE_LIMIT_BYTES): Promise<void> {
  const dir = offlineThumbCacheDir();
  const names = await readdir(dir).catch(() => []);
  const files = (
    await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(dir, name)).catch(() => null);
        return info ? { path: join(dir, name), size: info.size, mtimeMs: info.mtimeMs } : null;
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  let total = files.reduce((sum, entry) => sum + entry.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of files) {
    if (total <= limit) break;
    await rm(entry.path, { force: true });
    total -= entry.size;
  }
}

async function storeOfflineThumb(target: string, output: Buffer): Promise<void> {
  await mkdir(offlineThumbCacheDir(), { recursive: true });
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, output);
  await rename(temp, target).catch(() => rm(temp, { force: true }));
  const state = thumbState();
  state.writesSincePrune += 1;
  if (state.writesSincePrune >= PRUNE_EVERY) {
    state.writesSincePrune = 0;
    void pruneOfflineThumbCache().catch(() => {});
  }
}

function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  killer.on("error", () => child.kill());
}

/** Builds ffmpeg arguments to encode a single 320 px WebP thumbnail (image or video frame) to stdout. */
export function offlineFfmpegThumbArgs(fullPath: string, kind: "image" | "video", seekSeconds = "0.1"): string[] {
  const base = ["-hide_banner", "-loglevel", "error", "-nostats", "-nostdin"];
  if (kind === "video") base.push("-ss", seekSeconds);
  return [
    ...base,
    "-threads",
    "1",
    "-i",
    fullPath,
    "-frames:v",
    "1",
    "-an",
    "-vf",
    `scale=w='min(${OFFLINE_THUMB_SIZE},iw)':h='min(${OFFLINE_THUMB_SIZE},ih)':force_original_aspect_ratio=decrease`,
    "-vcodec",
    "libwebp",
    "-quality",
    "70",
    "-f",
    "webp",
    "pipe:1",
  ];
}

function looksLikeWebp(buf: Buffer): boolean {
  return buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
}

export type FfmpegCommand = string | { exe: string; prefixArgs: string[] };

function runFfmpegWebp(
  command: FfmpegCommand,
  fullPath: string,
  kind: "image" | "video",
  seekSeconds = "0.1",
): Promise<{ bytes: Buffer | null; spawnFailed?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { bytes: Buffer | null; spawnFailed?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const exe = typeof command === "string" ? command : command.exe;
    const args = [
      ...(typeof command === "string" ? [] : command.prefixArgs),
      ...offlineFfmpegThumbArgs(fullPath, kind, seekSeconds),
    ];
    let child: ChildProcess;
    try {
      child = spawn(/*turbopackIgnore: true*/ exe, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish({ bytes: null, spawnFailed: true });
      return;
    }

    // Keep thumbnail generation out of the way of interactive PC work and downloads.
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Process may already have exited or OS may restrict priority lowering.
      }
    }

    const chunks: Buffer[] = [];
    let size = 0;
    timer = setTimeout(() => {
      killTree(child);
      finish({ bytes: null });
    }, CAPTURE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        killTree(child);
        finish({ bytes: null });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish({ bytes: null, spawnFailed: true }));
    child.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        finish({ bytes: null });
        return;
      }
      const out = Buffer.concat(chunks);
      finish({ bytes: looksLikeWebp(out) ? out : null });
    });
  });
}

export async function generateWithFfmpeg(
  command: FfmpegCommand,
  fullPath: string,
  kind: "image" | "video",
): Promise<Buffer | null> {
  if (kind === "video") {
    const first = await runFfmpegWebp(command, fullPath, "video", "0.1");
    if (first.bytes) return first.bytes;
    if (first.spawnFailed) return null;
    const second = await runFfmpegWebp(command, fullPath, "video", "0");
    return second.bytes;
  }
  const res = await runFfmpegWebp(command, fullPath, "image");
  return res.bytes;
}

export async function cachedOfflineThumbnail(
  fullPath: string,
  file: { size: number; mtimeMs: number },
): Promise<Buffer | null> {
  return readFile(cachePath(fullPath, file)).catch(() => null);
}

export type OfflineThumbOutcome =
  | { status: "ok"; bytes: Buffer }
  | { status: "paused" }
  | { status: "unavailable"; fallback: "canvas" | "placeholder" };

export interface GetOfflineThumbOptions {
  /** If true, returns `{ status: "paused" }` immediately when a download run is active instead of waiting. */
  failFastWhenPaused?: boolean;
  scheduler?: OfflineThumbScheduler;
  findFfmpegFn?: () => Promise<FfmpegCommand | null>;
  loadSharpFn?: () => Promise<Sharp | null>;
}

/**
 * Returns a 320 px WebP thumbnail for an image or video, cached under `.gather/offline-thumbs/`.
 * Cache hits return immediately. Cache misses are serialized one at a time, paused while gallery-dl runs,
 * and run ffmpeg at below-normal process priority.
 */
export async function getOfflineThumbnail(
  fullPath: string,
  kind: "image" | "video",
  file: { size: number; mtimeMs: number },
  options: GetOfflineThumbOptions = {},
): Promise<OfflineThumbOutcome> {
  const target = cachePath(fullPath, file);
  const hit = await readFile(target).catch(() => null);
  if (hit) return { status: "ok", bytes: hit };

  const scheduler = options.scheduler ?? getOfflineThumbScheduler();
  if (options.failFastWhenPaused && scheduler.paused) {
    return { status: "paused" };
  }

  const getSharp = options.loadSharpFn ?? loadSharp;
  const getFfmpeg = options.findFfmpegFn ?? findFfmpeg;

  const bytes = await scheduler.schedule(target, async () => {
    const again = await readFile(target).catch(() => null);
    if (again) return again;

    const sharp = await getSharp();

    if (kind === "image") {
      if (sharp) {
        try {
          const output = await sharp(fullPath, { failOn: "none" })
            .rotate()
            .resize({ width: OFFLINE_THUMB_SIZE, height: OFFLINE_THUMB_SIZE, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 70 })
            .toBuffer();
          await storeOfflineThumb(target, output);
          return output;
        } catch {
          // Fall through to ffmpeg if sharp cannot decode this image.
        }
      }
      const ffmpeg = await getFfmpeg();
      if (ffmpeg) {
        const output = await generateWithFfmpeg(ffmpeg, fullPath, "image");
        if (output) {
          await storeOfflineThumb(target, output);
          return output;
        }
      }
      return null;
    }

    // Video: reuse an already-built 480 px desktop poster if present (cheap downscale, no video decode).
    if (sharp) {
      const desktopPoster = await cachedThumbnail(fullPath, 480, file);
      if (desktopPoster) {
        try {
          const output = await sharp(desktopPoster, { failOn: "none" })
            .resize({ width: OFFLINE_THUMB_SIZE, height: OFFLINE_THUMB_SIZE, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 70 })
            .toBuffer();
          await storeOfflineThumb(target, output);
          return output;
        } catch {
          /* fall back to ffmpeg */
        }
      }
    }

    const ffmpeg = await getFfmpeg();
    if (!ffmpeg) return null;
    const output = await generateWithFfmpeg(ffmpeg, fullPath, "video");
    if (!output) return null;
    await storeOfflineThumb(target, output);
    return output;
  });

  if (bytes) return { status: "ok", bytes };
  return { status: "unavailable", fallback: kind === "image" ? "canvas" : "placeholder" };
}
