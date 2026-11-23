import "server-only";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { constants as osConstants, setPriority } from "node:os";
import { join } from "node:path";
import type { MediaKind } from "@/components/gallery/types";
import { presetIdForKind } from "@/lib/offline";
import type {
  OfflineImageSettings,
  OfflineSettings,
  OfflineVideoSettings,
  VideoCodecName,
} from "@/lib/offline";
import {
  buildVideoTranscodeArgs,
  detectVideoEncoders,
  selectVideoEncoder,
} from "@/server/offline/encoder";
import type { EncoderDetectionResult } from "@/server/offline/encoder";
import { isPluggedIn } from "@/server/offline/power";
import { isGalleryDlRunActive } from "@/server/offline/thumbs";
import type { FfmpegCommand } from "@/server/offline/thumbs";
import { gatherHome } from "@/server/store";

const QUALITY_FLOOR = 40;
const QUALITY_STEP = 5;
const DIMENSION_STEP_FACTOR = 0.85;
const MIN_IMAGE_EDGE = 256;
const MAX_DIMENSION_STEPS = 12;
const VIDEO_TIMEOUT_MS = 10 * 60 * 1000;
const PAUSE_POLL_MS = 300;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
};

const PASSTHROUGH_FORMATS: Record<string, { ext: string; contentType: string }> = {
  jpeg: { ext: "jpg", contentType: "image/jpeg" },
  webp: { ext: "webp", contentType: "image/webp" },
  png: { ext: "png", contentType: "image/png" },
};

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

export function offlineFilesCacheDir(): string {
  return join(gatherHome(), "offline-files");
}

export function offlineDerivativeKey(
  account: string,
  relPath: string,
  version: string,
  preset: string,
): string {
  return createHash("sha1").update(`${account}/${relPath}|${version}|${preset}`).digest("hex");
}

export interface CachedDerivative {
  key: string;
  path: string;
  ext: string;
  contentType: string;
  size: number;
  mtimeMs: number;
}

export interface PreparedImageResult {
  bytes: Buffer;
  ext: string;
  contentType: string;
  passthrough: boolean;
  width?: number;
  height?: number;
  qualityUsed?: number;
}

/**
 * Resizes and encodes an image to fit within `image.maxEdge` and `image.maxKB`:
 * 1. Files already within limits and in an accepted browser format (JPEG/WebP/PNG, non-animated, normal orientation)
 *    are served as-is with no re-encode.
 * 2. Otherwise resize longest edge <= maxEdge (never upscale), encode at starting quality, step quality down by 5 to
 *    40 if over maxKB, then reduce dimensions by 15% steps if still over maxKB.
 */
export async function fitImageToOfflineLimits(
  sourcePath: string,
  sourceSize: number,
  image: OfflineImageSettings,
  loadSharpFn: () => Promise<Sharp | null> = loadSharp,
): Promise<PreparedImageResult | null> {
  const sharp = await loadSharpFn();
  if (!sharp) return null;

  const maxBytes = image.maxKB * 1024;
  const meta = await sharp(sourcePath, { failOn: "none" }).metadata();
  const rawW = meta.width ?? 0;
  const rawH = meta.height ?? 0;
  const swapped = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
  const origW = swapped ? rawH : rawW;
  const origH = swapped ? rawW : rawH;

  const passthroughFormat = meta.format ? PASSTHROUGH_FORMATS[meta.format] : undefined;
  const isAnimated = (meta.pages ?? 1) > 1;
  const normalOrientation = !meta.orientation || meta.orientation === 1;
  const fitsDimensions =
    image.maxEdge === "original" || (origW > 0 && origH > 0 && Math.max(origW, origH) <= image.maxEdge);

  if (passthroughFormat && !isAnimated && normalOrientation && fitsDimensions && sourceSize <= maxBytes) {
    const bytes = await readFile(sourcePath);
    return {
      bytes,
      ext: passthroughFormat.ext,
      contentType: passthroughFormat.contentType,
      passthrough: true,
      width: origW || undefined,
      height: origH || undefined,
    };
  }

  let targetW = origW;
  let targetH = origH;
  if (image.maxEdge !== "original" && origW > 0 && origH > 0 && Math.max(origW, origH) > image.maxEdge) {
    const scale = image.maxEdge / Math.max(origW, origH);
    targetW = Math.max(1, Math.round(origW * scale));
    targetH = Math.max(1, Math.round(origH * scale));
  }

  const ext = image.format === "webp" ? "webp" : "jpg";
  const contentType = image.format === "webp" ? "image/webp" : "image/jpeg";

  // Decode and rotate once into raw pixels at the starting maxEdge dimensions so quality/size iterations
  // never re-decode the source image from disk.
  let basePipeline = sharp(sourcePath, { failOn: "none" }).rotate();
  if (targetW > 0 && targetH > 0) {
    basePipeline = basePipeline.resize({ width: targetW, height: targetH, fit: "inside", withoutEnlargement: true });
  }
  const decoded = await basePipeline.raw().toBuffer({ resolveWithObject: true });
  const baseRaw = decoded.data;
  const baseInfo = {
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
  };
  targetW = baseInfo.width;
  targetH = baseInfo.height;

  async function encode(w: number, h: number, quality: number): Promise<Buffer> {
    let pipeline = sharp!(baseRaw, { raw: baseInfo });
    if (w !== baseInfo.width || h !== baseInfo.height) {
      pipeline = pipeline.resize({ width: w, height: h, fit: "inside", withoutEnlargement: true });
    }
    if (image.format === "webp") {
      return pipeline.webp({ quality, effort: 3 }).toBuffer();
    }
    return pipeline.jpeg({ quality, progressive: true }).toBuffer();
  }

  let quality = Math.max(QUALITY_FLOOR, image.quality);
  let output = await encode(targetW, targetH, quality);

  while (output.length > maxBytes && quality > QUALITY_FLOOR) {
    quality = Math.max(QUALITY_FLOOR, quality - QUALITY_STEP);
    output = await encode(targetW, targetH, quality);
  }

  let dimSteps = 0;
  while (output.length > maxBytes && Math.max(targetW, targetH) > MIN_IMAGE_EDGE && dimSteps < MAX_DIMENSION_STEPS) {
    dimSteps += 1;
    let nextW = Math.max(1, Math.round(targetW * DIMENSION_STEP_FACTOR));
    let nextH = Math.max(1, Math.round(targetH * DIMENSION_STEP_FACTOR));
    if (Math.max(nextW, nextH) < MIN_IMAGE_EDGE) {
      const scale = MIN_IMAGE_EDGE / Math.max(targetW, targetH);
      nextW = Math.max(1, Math.round(targetW * scale));
      nextH = Math.max(1, Math.round(targetH * scale));
    }
    if (nextW === targetW && nextH === targetH) break;
    targetW = nextW;
    targetH = nextH;
    output = await encode(targetW, targetH, quality);
  }

  return {
    bytes: output,
    ext,
    contentType,
    passthrough: false,
    width: targetW || undefined,
    height: targetH || undefined,
    qualityUsed: quality,
  };
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

function runFfmpegTranscode(
  command: FfmpegCommand,
  args: string[],
  signal?: AbortSignal,
  onChild?: (child: ChildProcess | null) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | null = null;
    const onAbort = () => {
      if (child) killTree(child);
      finish(false);
    };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      onChild?.(null);
      resolve(ok);
    };

    const exe = typeof command === "string" ? command : command.exe;
    const fullArgs = [...(typeof command === "string" ? [] : command.prefixArgs), ...args];

    try {
      child = spawn(/*turbopackIgnore: true*/ exe, fullArgs, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      finish(false);
      return;
    }
    onChild?.(child);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Process may already have exited or OS may restrict priority lowering.
      }
    }

    timer = setTimeout(() => {
      if (child) killTree(child);
      finish(false);
    }, VIDEO_TIMEOUT_MS);

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

export async function transcodeVideoToFile(
  sourcePath: string,
  targetPath: string,
  video: OfflineVideoSettings,
  options: {
    signal?: AbortSignal;
    onChild?: (child: ChildProcess | null) => void;
    detectEncodersFn?: () => Promise<EncoderDetectionResult>;
  } = {},
): Promise<boolean> {
  const encoders = await (options.detectEncodersFn ? options.detectEncodersFn() : detectVideoEncoders());
  if (!encoders.ffmpegAvailable || !encoders.command) return false;
  const selected = selectVideoEncoder(video.encoder, encoders);
  if (!selected.codec) return false;

  const dir = offlineFilesCacheDir();
  await mkdir(dir, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;

  const tryCodec = async (codec: VideoCodecName): Promise<boolean> => {
    await rm(tempPath, { force: true }).catch(() => {});
    const args = buildVideoTranscodeArgs(sourcePath, tempPath, video, codec);
    const ok = await runFfmpegTranscode(encoders.command!, args, options.signal, options.onChild);
    if (!ok || options.signal?.aborted) {
      await rm(tempPath, { force: true }).catch(() => {});
      return false;
    }
    const info = await stat(tempPath).catch(() => null);
    if (!info || !info.isFile() || info.size === 0) {
      await rm(tempPath, { force: true }).catch(() => {});
      return false;
    }
    try {
      await rename(tempPath, targetPath);
      return true;
    } catch {
      await rm(tempPath, { force: true }).catch(() => {});
      return false;
    }
  };

  if (await tryCodec(selected.codec)) return true;

  // If a GPU encoder failed on an unusual clip (e.g. 10-bit profile) under "auto", retry on CPU once.
  if (
    !options.signal?.aborted &&
    video.encoder === "auto" &&
    selected.codec !== "libx264" &&
    encoders.hasCpu
  ) {
    return tryCodec("libx264");
  }
  return false;
}

export type PauseReason = "download" | "battery" | null;

export interface DerivativeJob {
  key: string;
  account: string;
  relPath: string;
  fullPath: string;
  kind: MediaKind;
  size: number;
  mtimeMs: number;
  v: string;
  settings: OfflineSettings;
}

export interface OfflineDerivativeSchedulerDeps {
  isDownloadActive?: () => boolean;
  isPluggedIn?: () => Promise<boolean>;
  pollMs?: number;
  loadSharpFn?: () => Promise<Sharp | null>;
  detectEncodersFn?: () => Promise<EncoderDetectionResult>;
  onDerivativeWritten?: () => void;
  getCacheDir?: () => string;
}

interface QueuedEntry {
  job: DerivativeJob;
  resolve: (result: CachedDerivative | null) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Low-impact Layer 3 derivative scheduler:
 * - Strictly 1 job at a time (concurrency = 1)
 * - Priority queue (phone on-demand requests) runs ahead of background pre-generation
 * - Pauses when a gallery-dl run is active OR when onlyWhenPluggedIn is true and PC is on battery
 * - Tracks and cleanly kills active ffmpeg child processes on shutdown / settings change
 */
export class OfflineDerivativeScheduler {
  private readonly isDownloadActiveFn: () => boolean;
  private readonly isPluggedInFn: () => Promise<boolean>;
  private readonly pollMs: number;
  private readonly loadSharpFn: () => Promise<Sharp | null>;
  private readonly detectEncodersFn?: () => Promise<EncoderDetectionResult>;
  private readonly onDerivativeWritten?: () => void;
  private readonly getCacheDir: () => string;

  private readonly priorityQueue: QueuedEntry[] = [];
  private readonly backgroundQueue: QueuedEntry[] = [];
  private readonly inFlight = new Map<string, Promise<CachedDerivative | null>>();
  private activeChild: ChildProcess | null = null;
  private activeAbort: AbortController | null = null;
  private pumping = false;
  private runningCount = 0;

  constructor(deps: OfflineDerivativeSchedulerDeps = {}) {
    this.isDownloadActiveFn = deps.isDownloadActive ?? isGalleryDlRunActive;
    this.isPluggedInFn = deps.isPluggedIn ?? (() => isPluggedIn());
    this.pollMs = deps.pollMs ?? PAUSE_POLL_MS;
    this.loadSharpFn = deps.loadSharpFn ?? loadSharp;
    this.detectEncodersFn = deps.detectEncodersFn;
    this.onDerivativeWritten = deps.onDerivativeWritten;
    this.getCacheDir = deps.getCacheDir ?? offlineFilesCacheDir;
  }

  get activeJobs(): number {
    return this.runningCount;
  }

  get pendingCount(): number {
    return this.priorityQueue.length + this.backgroundQueue.length;
  }

  async getPauseReason(onlyWhenPluggedIn: boolean): Promise<PauseReason> {
    if (this.isDownloadActiveFn()) return "download";
    if (onlyWhenPluggedIn) {
      const plugged = await this.isPluggedInFn().catch(() => true);
      if (!plugged) return "battery";
    }
    return null;
  }

  enqueue(job: DerivativeJob, options: { priority?: boolean } = {}): Promise<CachedDerivative | null> {
    const existing = this.inFlight.get(job.key);
    if (existing) {
      // Promote from backgroundQueue to priorityQueue if a phone asks on demand.
      if (options.priority) {
        const idx = this.backgroundQueue.findIndex((entry) => entry.job.key === job.key);
        if (idx !== -1) {
          const [promoted] = this.backgroundQueue.splice(idx, 1);
          if (promoted) this.priorityQueue.push(promoted);
        }
      }
      return existing;
    }

    let resolvePromise!: (value: CachedDerivative | null) => void;
    const promise = new Promise<CachedDerivative | null>((resolve) => {
      resolvePromise = resolve;
    });

    const wrapped = promise.finally(() => {
      this.inFlight.delete(job.key);
    });
    this.inFlight.set(job.key, wrapped);

    const entry: QueuedEntry = { job, resolve: resolvePromise };
    if (options.priority) {
      this.priorityQueue.push(entry);
    } else {
      this.backgroundQueue.push(entry);
    }

    void this.pump();
    return wrapped;
  }

  /** Cancels all queued work and kills any running ffmpeg transcode cleanly. */
  cancelAll(): void {
    this.activeAbort?.abort();
    if (this.activeChild) {
      killTree(this.activeChild);
      this.activeChild = null;
    }
    while (this.priorityQueue.length > 0) {
      const item = this.priorityQueue.shift();
      item?.resolve(null);
    }
    while (this.backgroundQueue.length > 0) {
      const item = this.backgroundQueue.shift();
      item?.resolve(null);
    }
  }

  private nextEntry(): QueuedEntry | undefined {
    return this.priorityQueue.shift() ?? this.backgroundQueue.shift();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.priorityQueue.length > 0 || this.backgroundQueue.length > 0) {
        const entry = this.nextEntry();
        if (!entry) break;
        const abort = new AbortController();
        this.activeAbort = abort;

        try {
          while (!abort.signal.aborted) {
            const reason = await this.getPauseReason(entry.job.settings.onlyWhenPluggedIn);
            if (!reason) break;
            await sleep(this.pollMs, abort.signal);
          }
          if (abort.signal.aborted) {
            entry.resolve(null);
            continue;
          }

          this.runningCount += 1;
          try {
            const result = await this.executeJob(entry.job, abort.signal);
            entry.resolve(result);
          } finally {
            this.runningCount -= 1;
          }
        } catch {
          entry.resolve(null);
        } finally {
          if (this.activeAbort === abort) this.activeAbort = null;
        }
      }
    } finally {
      this.pumping = false;
      if (this.priorityQueue.length > 0 || this.backgroundQueue.length > 0) {
        void this.pump();
      }
    }
  }

  private async executeJob(job: DerivativeJob, signal: AbortSignal): Promise<CachedDerivative | null> {
    const dir = this.getCacheDir();
    const cached = await lookupCachedDerivativeInDir(dir, job.key);
    if (cached) return cached;

    await mkdir(dir, { recursive: true });
    let written: CachedDerivative | null = null;

    if (job.kind === "image") {
      const fitted = await fitImageToOfflineLimits(job.fullPath, job.size, job.settings.image, this.loadSharpFn);
      if (!fitted || signal.aborted) return null;
      const target = join(/*turbopackIgnore: true*/ dir, `${job.key}.${fitted.ext}`);
      const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        if (fitted.passthrough) {
          await copyFile(job.fullPath, temp);
        } else {
          await writeFile(temp, fitted.bytes);
        }
        await rename(temp, target);
        const info = await stat(target);
        written = {
          key: job.key,
          path: target,
          ext: fitted.ext,
          contentType: fitted.contentType,
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
      } catch {
        await rm(temp, { force: true }).catch(() => {});
        return null;
      }
    } else {
      const target = join(/*turbopackIgnore: true*/ dir, `${job.key}.mp4`);
      const ok = await transcodeVideoToFile(job.fullPath, target, job.settings.video, {
        signal,
        onChild: (child) => {
          this.activeChild = child;
        },
        detectEncodersFn: this.detectEncodersFn,
      });
      if (!ok || signal.aborted) return null;
      const info = await stat(target).catch(() => null);
      if (!info) return null;
      written = {
        key: job.key,
        path: target,
        ext: "mp4",
        contentType: "video/mp4",
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }

    if (written) {
      recordCachedDerivative(dir, written);
      const limitBytes = job.settings.pcCacheMB * 1024 * 1024;
      await pruneOfflineFilesCache(limitBytes, dir).catch(() => {});
      this.onDerivativeWritten?.();
    }
    return written;
  }
}

interface DerivativeGlobalState {
  scheduler: OfflineDerivativeScheduler;
  cacheDir: string | null;
  cacheLoaded: boolean;
  cacheMap: Map<string, CachedDerivative>;
  revision: number;
  listeners: Set<() => void>;
}

const DERIVATIVES_STATE_KEY = Symbol.for("gather.offline.derivatives");

function derivativeState(): DerivativeGlobalState {
  const holder = globalThis as unknown as Record<symbol, DerivativeGlobalState | undefined>;
  if (!holder[DERIVATIVES_STATE_KEY]) {
    const listeners = new Set<() => void>();
    const state: DerivativeGlobalState = {
      scheduler: new OfflineDerivativeScheduler({
        onDerivativeWritten: () => {
          state.revision += 1;
          for (const listener of listeners) listener();
        },
      }),
      cacheDir: null,
      cacheLoaded: false,
      cacheMap: new Map(),
      revision: 0,
      listeners,
    };
    holder[DERIVATIVES_STATE_KEY] = state;
  }
  return holder[DERIVATIVES_STATE_KEY]!;
}

export function onOfflineDerivativeChange(listener: () => void): () => void {
  const state = derivativeState();
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function getDerivativesRevision(): number {
  return derivativeState().revision;
}

export function getOfflineDerivativeScheduler(): OfflineDerivativeScheduler {
  return derivativeState().scheduler;
}

export function resetOfflineDerivativeState(): void {
  const state = derivativeState();
  state.scheduler.cancelAll();
  state.cacheDir = null;
  state.cacheLoaded = false;
  state.cacheMap.clear();
  state.revision += 1;
}

function parseCacheFilename(name: string): { key: string; ext: string; contentType: string } | null {
  if (name.endsWith(".tmp") || name.includes(".tmp.")) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const key = name.slice(0, dot);
  const ext = name.slice(dot + 1).toLowerCase();
  const contentType = EXT_TO_CONTENT_TYPE[ext];
  if (!contentType) return null;
  return { key, ext, contentType };
}

export async function ensureDerivativeCacheLoaded(dir: string = offlineFilesCacheDir()): Promise<Map<string, CachedDerivative>> {
  const state = derivativeState();
  if (state.cacheLoaded && state.cacheDir === dir) {
    return state.cacheMap;
  }
  const map = new Map<string, CachedDerivative>();
  const names = await readdir(/*turbopackIgnore: true*/ dir).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const parsed = parseCacheFilename(name);
      if (!parsed) return;
      const full = join(/*turbopackIgnore: true*/ dir, name);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) return;
      map.set(parsed.key, {
        key: parsed.key,
        path: full,
        ext: parsed.ext,
        contentType: parsed.contentType,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }),
  );
  state.cacheDir = dir;
  state.cacheMap = map;
  state.cacheLoaded = true;
  return map;
}

function recordCachedDerivative(dir: string, entry: CachedDerivative): void {
  const state = derivativeState();
  if (state.cacheDir === dir && state.cacheLoaded) {
    state.cacheMap.set(entry.key, entry);
  }
}

async function lookupCachedDerivativeInDir(dir: string, key: string): Promise<CachedDerivative | null> {
  const map = await ensureDerivativeCacheLoaded(dir);
  const hit = map.get(key);
  if (hit) {
    const info = await stat(hit.path).catch(() => null);
    if (info?.isFile()) {
      hit.size = info.size;
      hit.mtimeMs = info.mtimeMs;
      return hit;
    }
    map.delete(key);
  }
  return null;
}

/** Fast in-memory lookup after `ensureDerivativeCacheLoaded()`, used by index building. */
export function getCachedDerivativeSync(key: string): CachedDerivative | null {
  const state = derivativeState();
  if (!state.cacheLoaded || state.cacheDir !== offlineFilesCacheDir()) return null;
  return state.cacheMap.get(key) ?? null;
}

/** Looks up a cached derivative on disk and refreshes its LRU mtime when stale. */
export async function getCachedOfflineDerivative(
  account: string,
  relPath: string,
  v: string,
  kind: MediaKind,
  settings: OfflineSettings,
): Promise<CachedDerivative | null> {
  const preset = presetIdForKind(kind, settings);
  const key = offlineDerivativeKey(account, relPath, v, preset);
  const hit = await lookupCachedDerivativeInDir(offlineFilesCacheDir(), key);
  if (!hit) return null;

  // Touch mtime at most once per hour so LRU eviction keeps recently-used files without write amplification.
  const now = Date.now();
  if (now - hit.mtimeMs > TOUCH_INTERVAL_MS) {
    const date = new Date(now);
    void utimes(hit.path, date, date)
      .then(() => {
        hit.mtimeMs = now;
      })
      .catch(() => {});
  }
  return hit;
}

/** Enqueues derivative preparation with optional priority (on-demand phone request). */
export function enqueueOfflineDerivative(
  params: {
    account: string;
    relPath: string;
    fullPath: string;
    kind: MediaKind;
    size: number;
    mtimeMs: number;
    v: string;
    settings: OfflineSettings;
  },
  options: { priority?: boolean } = {},
): Promise<CachedDerivative | null> {
  const preset = presetIdForKind(params.kind, params.settings);
  const key = offlineDerivativeKey(params.account, params.relPath, params.v, preset);
  return getOfflineDerivativeScheduler().enqueue(
    {
      key,
      account: params.account,
      relPath: params.relPath,
      fullPath: params.fullPath,
      kind: params.kind,
      size: params.size,
      mtimeMs: params.mtimeMs,
      v: params.v,
      settings: params.settings,
    },
    options,
  );
}

/** Evicts least-recently-used derivatives until total bytes under `.gather/offline-files/` fit within `limitBytes`. */
export async function pruneOfflineFilesCache(
  limitBytes: number,
  dir: string = offlineFilesCacheDir(),
): Promise<{ evicted: number; remainingBytes: number }> {
  const names = await readdir(/*turbopackIgnore: true*/ dir).catch(() => []);
  const entries = (
    await Promise.all(
      names.map(async (name) => {
        const parsed = parseCacheFilename(name);
        if (!parsed) return null;
        const full = join(/*turbopackIgnore: true*/ dir, name);
        const info = await stat(full).catch(() => null);
        return info?.isFile() ? { key: parsed.key, path: full, size: info.size, mtimeMs: info.mtimeMs } : null;
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) {
    return { evicted: 0, remainingBytes: total };
  }

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const state = derivativeState();
  let evicted = 0;

  for (const entry of entries) {
    if (total <= limitBytes) break;
    await rm(entry.path, { force: true }).catch(() => {});
    total -= entry.size;
    evicted += 1;
    if (state.cacheDir === dir && state.cacheLoaded) {
      state.cacheMap.delete(entry.key);
    }
  }

  if (evicted > 0) {
    state.revision += 1;
    for (const listener of state.listeners) listener();
  }
  return { evicted, remainingBytes: Math.max(0, total) };
}

/** Stops any running ffmpeg transcode and clears queued derivative work (called on shutdown / settings change). */
export function stopOfflineDerivatives(): void {
  getOfflineDerivativeScheduler().cancelAll();
}
