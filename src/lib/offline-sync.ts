import {
  DEFAULT_OFFLINE_SETTINGS,
  OFFLINE_FILES_CACHE,
  OFFLINE_THUMB_SIZE,
  OFFLINE_THUMBS_CACHE,
  offlineFileUrl,
  offlineRelPath,
  offlineThumbUrl,
  selectLayer3FilesWithinBudget,
} from "@/lib/offline";
import type { OfflineIndexFile, OfflineIndexResponse } from "@/lib/offline";
import {
  getOfflineDb,
  LAST_AUTOSYNC_KEY,
  wipeAllOnRevoke,
} from "@/lib/offline-db";
import type { OfflineDb, OfflineSyncMeta } from "@/lib/offline-db";

export const SYNC_CONCURRENCY = 4;
export const FILE_SYNC_CONCURRENCY = 2;
export const AUTO_SYNC_THROTTLE_MS = 5 * 60 * 1000;
const MAX_PREPARE_RETRIES = 2;

export interface SyncProgress {
  phase: "index" | "thumbs" | "files" | "pruning";
  done: number;
  total: number;
  cached: number;
  skipped: number;
  filesDone: number;
  filesTotal: number;
  filesCached: number;
  filesBytes: number;
  filesPending: number;
}

export type SyncOutcome =
  | {
      status: "done";
      meta: OfflineSyncMeta;
      cached: number;
      skipped: number;
      total: number;
      filesCached: number;
      filesTotal: number;
      filesBytes: number;
      filesPending: number;
    }
  | { status: "disabled" }
  | { status: "revoked" }
  | { status: "paused"; done: number; total: number; reason?: "download" | "battery" }
  | { status: "aborted"; done: number; total: number }
  | { status: "error"; message: string };

export interface StorageUsage {
  usage: number;
  quota: number;
  persisted: boolean;
}

export async function getStorageUsage(): Promise<StorageUsage | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  try {
    const [est, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted().catch(() => false) : Promise.resolve(false),
    ]);
    return {
      usage: est.usage ?? 0,
      quota: est.quota ?? 0,
      persisted,
    };
  } catch {
    return null;
  }
}

export function shouldAutoSync(now = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(LAST_AUTOSYNC_KEY);
    if (!raw) return true;
    const prev = Number(raw);
    return !Number.isFinite(prev) || now - prev >= AUTO_SYNC_THROTTLE_MS;
  } catch {
    return true;
  }
}

export function recordAutoSync(now = Date.now()): void {
  try {
    window.localStorage.setItem(LAST_AUTOSYNC_KEY, String(now));
  } catch {
    // ignore
  }
}

function requestShellPrecache(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.controller?.postMessage({ type: "PRECACHE_OFFLINE_SHELL" });
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

function responseSizeBytes(res: Response | undefined, fallback: number): number {
  const header = res?.headers.get("content-length");
  if (header) {
    const parsed = Number(header);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return Math.max(0, fallback);
}

/** Browser-side canvas fallback when PC-side thumbnails return 501 (no sharp/ffmpeg on PC). */
async function buildCanvasThumbFallback(file: OfflineIndexFile, signal?: AbortSignal): Promise<Response | null> {
  if (file.kind !== "image" || typeof document === "undefined") return null;
  const params = new URLSearchParams({
    account: file.account,
    path: offlineRelPath(file.folder, file.filename),
    v: file.v,
  });
  const res = await fetch(`/api/media?${params.toString()}`, { credentials: "same-origin", signal });
  if (res.status === 401) throw new RevokedError();
  if (!res.ok) return null;
  const sourceBlob = await res.blob();
  const objectUrl = URL.createObjectURL(sourceBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = objectUrl;
    });
    const maxDim = Math.max(img.naturalWidth, img.naturalHeight, 1);
    const scale = Math.min(1, OFFLINE_THUMB_SIZE / maxDim);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const blob =
      (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.72))) ??
      (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78)));
    if (!blob) return null;
    return new Response(blob, {
      status: 200,
      headers: { "content-type": blob.type || "image/webp" },
    });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

class RevokedError extends Error {
  constructor() {
    super("Device revoked");
  }
}

class PausedError extends Error {
  constructor() {
    super("Paused on PC");
  }
}

export interface RunOfflineSyncOptions {
  db?: OfflineDb;
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (progress: SyncProgress) => void;
}

export async function runOfflineSync(options: RunOfflineSyncOptions = {}): Promise<SyncOutcome> {
  const db = options.db ?? getOfflineDb();
  const signal = options.signal;
  const concurrency = Math.max(1, options.concurrency ?? SYNC_CONCURRENCY);

  if (typeof navigator !== "undefined" && navigator.storage?.persist) {
    void navigator.storage.persist().catch(() => false);
  }

  const emitProgress = (partial: SyncProgress) => options.onProgress?.(partial);

  emitProgress({
    phase: "index",
    done: 0,
    total: 0,
    cached: 0,
    skipped: 0,
    filesDone: 0,
    filesTotal: 0,
    filesCached: 0,
    filesBytes: 0,
    filesPending: 0,
  });

  const previousMeta = await db.getMeta().catch(() => null);
  const query =
    previousMeta?.indexVersion && previousMeta.indexVersion !== "disabled"
      ? `?since=${encodeURIComponent(previousMeta.indexVersion)}`
      : "";
  const headers: Record<string, string> = {};
  if (previousMeta?.indexVersion) {
    headers["if-none-match"] = `"${previousMeta.indexVersion}"`;
  }

  let indexRes: Response;
  try {
    indexRes = await fetch(`/m/api/offline/index${query}`, {
      method: "GET",
      credentials: "same-origin",
      headers,
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return { status: "aborted", done: 0, total: 0 };
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not reach your PC.",
    };
  }

  if (indexRes.status === 401) {
    await wipeAllOnRevoke(db);
    return { status: "revoked" };
  }

  const now = Date.now();
  let meta: OfflineSyncMeta;

  if (indexRes.status === 304) {
    if (!previousMeta || !previousMeta.enabled) {
      return { status: "disabled" };
    }
    meta = { ...previousMeta, lastSyncedAt: now };
    await db.setMeta(meta);
  } else if (indexRes.ok) {
    let payload: OfflineIndexResponse;
    try {
      payload = (await indexRes.json()) as OfflineIndexResponse;
    } catch {
      return { status: "error", message: "The PC returned an unreadable index." };
    }
    if (!payload.enabled) {
      return { status: "disabled" };
    }
    meta = await db.applySyncResponse(payload, now, previousMeta?.thumbCount ?? 0);
  } else {
    return { status: "error", message: `Sync failed (HTTP ${indexRes.status}).` };
  }

  requestShellPrecache();

  const allFiles = await db.listFiles();
  const total = allFiles.length;
  const budgetBytes = meta.phoneBudgetBytes ?? DEFAULT_OFFLINE_SETTINGS.phoneBudgetMB * 1024 * 1024;
  const selectedLayer3 = selectLayer3FilesWithinBudget(allFiles, budgetBytes);
  const filesTotal = selectedLayer3.length;

  if (typeof caches === "undefined") {
    const finalMeta: OfflineSyncMeta = {
      ...meta,
      lastSyncedAt: Date.now(),
      thumbCount: 0,
      fileTotal: filesTotal,
      fileCount: 0,
      fileBytes: 0,
      filePending: 0,
    };
    await db.setMeta(finalMeta);
    return {
      status: "done",
      meta: finalMeta,
      cached: 0,
      skipped: total,
      total,
      filesCached: 0,
      filesTotal,
      filesBytes: 0,
      filesPending: 0,
    };
  }

  const [thumbCache, filesCache] = await Promise.all([
    caches.open(OFFLINE_THUMBS_CACHE),
    caches.open(OFFLINE_FILES_CACHE),
  ]);

  const expectedThumbUrls = new Set<string>();
  const thumbEntries = allFiles.map((file) => {
    const url = offlineThumbUrl(file.account, file.folder, file.filename, file.v);
    expectedThumbUrls.add(new URL(url, window.location.origin).href);
    return { file, url };
  });

  const imagePresetChanged =
    previousMeta?.imagePreset !== undefined && previousMeta.imagePreset !== meta.imagePreset;
  const videoPresetChanged =
    previousMeta?.videoPreset !== undefined && previousMeta.videoPreset !== meta.videoPreset;

  const expectedFileMap = new Map<string, { file: OfflineIndexFile; url: string }>();
  const fileEntries = selectedLayer3.map((file) => {
    const url = offlineFileUrl(file.account, file.folder, file.filename, file.v);
    const abs = new URL(url, window.location.origin).href;
    const entry = { file, url };
    expectedFileMap.set(abs, entry);
    return { ...entry, abs };
  });

  // Prune cached thumbnails and Layer 3 files whose source was removed, changed preset, or fell outside budget.
  emitProgress({
    phase: "pruning",
    done: 0,
    total,
    cached: 0,
    skipped: 0,
    filesDone: 0,
    filesTotal,
    filesCached: 0,
    filesBytes: 0,
    filesPending: 0,
  });

  const existingThumbKeys = await thumbCache.keys();
  const cachedThumbSet = new Set<string>();
  for (const req of existingThumbKeys) {
    if (!expectedThumbUrls.has(req.url)) {
      await thumbCache.delete(req);
    } else {
      cachedThumbSet.add(req.url);
    }
  }

  const existingFileKeys = await filesCache.keys();
  const cachedFileBytesMap = new Map<string, number>();
  for (const req of existingFileKeys) {
    const expected = expectedFileMap.get(req.url);
    const stalePreset =
      expected &&
      ((expected.file.kind === "image" && imagePresetChanged) ||
        (expected.file.kind === "video" && videoPresetChanged));
    if (!expected || stalePreset) {
      await filesCache.delete(req);
      continue;
    }
    const cachedRes = await filesCache.match(req);
    if (!cachedRes || !cachedRes.ok) {
      await filesCache.delete(req);
      continue;
    }
    cachedFileBytesMap.set(req.url, responseSizeBytes(cachedRes, expected.file.offline?.bytes ?? 0));
  }

  // Enforce actual byte budget against already-cached files (keep newest first, prune oldest over budget).
  let cachedFileBytes = 0;
  let cachedFileCount = 0;
  for (const entry of fileEntries) {
    const existingBytes = cachedFileBytesMap.get(entry.abs);
    if (existingBytes === undefined) continue;
    if (cachedFileBytes + existingBytes > budgetBytes) {
      await filesCache.delete(entry.url);
      cachedFileBytesMap.delete(entry.abs);
    } else {
      cachedFileBytes += existingBytes;
      cachedFileCount += 1;
    }
  }

  // Phase 1: sync missing 320 px thumbnails.
  const missingThumbs = thumbEntries.filter(
    (entry) => !cachedThumbSet.has(new URL(entry.url, window.location.origin).href),
  );
  let cachedThumbCount = thumbEntries.length - missingThumbs.length;
  let skippedThumbCount = 0;
  let doneThumbCount = cachedThumbCount;

  emitProgress({
    phase: "thumbs",
    done: doneThumbCount,
    total,
    cached: cachedThumbCount,
    skipped: skippedThumbCount,
    filesDone: cachedFileCount,
    filesTotal,
    filesCached: cachedFileCount,
    filesBytes: cachedFileBytes,
    filesPending: 0,
  });

  if (missingThumbs.length > 0) {
    const workerAbort = new AbortController();
    const onOuterAbort = () => workerAbort.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    let cursor = 0;
    let revoked = false;
    let paused = false;

    async function thumbWorker(): Promise<void> {
      while (!workerAbort.signal.aborted) {
        const index = cursor++;
        if (index >= missingThumbs.length) return;
        const { file, url } = missingThumbs[index]!;
        try {
          const res = await fetch(url, {
            method: "GET",
            credentials: "same-origin",
            signal: workerAbort.signal,
          });
          if (res.status === 401) {
            revoked = true;
            workerAbort.abort();
            return;
          }
          if (res.status === 503) {
            paused = true;
            workerAbort.abort();
            return;
          }
          if (res.ok) {
            await thumbCache.put(url, res);
            cachedThumbCount += 1;
          } else if (res.status === 501 && file.kind === "image") {
            const fallback = await buildCanvasThumbFallback(file, workerAbort.signal);
            if (fallback) {
              await thumbCache.put(url, fallback);
              cachedThumbCount += 1;
            } else {
              skippedThumbCount += 1;
            }
          } else {
            skippedThumbCount += 1;
          }
        } catch (error) {
          if (error instanceof RevokedError) {
            revoked = true;
            workerAbort.abort();
            return;
          }
          if (error instanceof PausedError) {
            paused = true;
            workerAbort.abort();
            return;
          }
          if (workerAbort.signal.aborted) return;
          skippedThumbCount += 1;
        }
        doneThumbCount += 1;
        emitProgress({
          phase: "thumbs",
          done: doneThumbCount,
          total,
          cached: cachedThumbCount,
          skipped: skippedThumbCount,
          filesDone: cachedFileCount,
          filesTotal,
          filesCached: cachedFileCount,
          filesBytes: cachedFileBytes,
          filesPending: 0,
        });
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, missingThumbs.length) }, () => thumbWorker()));
    } finally {
      signal?.removeEventListener("abort", onOuterAbort);
    }

    if (revoked) {
      await wipeAllOnRevoke(db);
      return { status: "revoked" };
    }
    if (paused) {
      await db.setMeta({
        ...meta,
        thumbCount: cachedThumbCount,
        fileTotal: filesTotal,
        fileCount: cachedFileCount,
        fileBytes: cachedFileBytes,
      });
      return { status: "paused", done: doneThumbCount, total, reason: "download" };
    }
    if (signal?.aborted) {
      await db.setMeta({
        ...meta,
        thumbCount: cachedThumbCount,
        fileTotal: filesTotal,
        fileCount: cachedFileCount,
        fileBytes: cachedFileBytes,
      });
      return { status: "aborted", done: doneThumbCount, total };
    }
  }

  // Phase 2: sync Layer 3 offline copies newest-first within phoneBudgetBytes.
  let pendingQueue = fileEntries.filter((entry) => !cachedFileBytesMap.has(entry.abs));
  let filesDone = cachedFileCount;
  let filesPending = 0;

  if (pendingQueue.length > 0) {
    emitProgress({
      phase: "files",
      done: doneThumbCount,
      total,
      cached: cachedThumbCount,
      skipped: skippedThumbCount,
      filesDone,
      filesTotal,
      filesCached: cachedFileCount,
      filesBytes: cachedFileBytes,
      filesPending: 0,
    });

    let revoked = false;
    let paused = false;
    let pauseReason: "download" | "battery" | undefined;
    let budgetReached = false;

    for (let attempt = 0; attempt <= MAX_PREPARE_RETRIES && pendingQueue.length > 0; attempt += 1) {
      if (signal?.aborted || revoked || paused || budgetReached) break;

      const nextRetry: typeof pendingQueue = [];
      let maxRetryMs = 500;

      const workerAbort = new AbortController();
      const onOuterAbort = () => workerAbort.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

      let cursor = 0;
      const batch = pendingQueue;

      async function fileWorker(): Promise<void> {
        while (!workerAbort.signal.aborted) {
          if (budgetReached) return;
          const index = cursor++;
          if (index >= batch.length) return;
          const entry = batch[index]!;
          const estBytes = entry.file.offline?.bytes ?? 0;
          if (cachedFileBytes + estBytes > budgetBytes && cachedFileCount > 0) {
            budgetReached = true;
            workerAbort.abort();
            return;
          }

          try {
            const res = await fetch(entry.url, {
              method: "GET",
              credentials: "same-origin",
              cache: "no-store",
              signal: workerAbort.signal,
            });
            if (res.status === 401) {
              revoked = true;
              workerAbort.abort();
              return;
            }
            if (res.status === 503) {
              paused = true;
              try {
                const body = (await res.json()) as { reason?: "download" | "battery" };
                pauseReason = body.reason;
              } catch {
                // ignore
              }
              workerAbort.abort();
              return;
            }
            if (res.status === 202) {
              const retrySec = Number(res.headers.get("retry-after") ?? "1");
              if (Number.isFinite(retrySec) && retrySec > 0) {
                maxRetryMs = Math.max(maxRetryMs, Math.min(2000, retrySec * 1000));
              }
              nextRetry.push(entry);
            } else if (res.ok) {
              const actualBytes = responseSizeBytes(res, estBytes);
              if (cachedFileBytes + actualBytes > budgetBytes && cachedFileCount > 0) {
                budgetReached = true;
                workerAbort.abort();
                return;
              }
              await filesCache.put(entry.url, res);
              cachedFileBytesMap.set(entry.abs, actualBytes);
              cachedFileCount += 1;
              cachedFileBytes += actualBytes;
              filesDone += 1;
            } else {
              // 403/404/501 — excluded or unavailable (e.g. no ffmpeg on PC); skip cleanly.
              filesDone += 1;
            }
          } catch {
            if (workerAbort.signal.aborted) return;
            filesDone += 1;
          }

          emitProgress({
            phase: "files",
            done: doneThumbCount,
            total,
            cached: cachedThumbCount,
            skipped: skippedThumbCount,
            filesDone,
            filesTotal,
            filesCached: cachedFileCount,
            filesBytes: cachedFileBytes,
            filesPending: nextRetry.length,
          });
        }
      }

      try {
        await Promise.all(
          Array.from({ length: Math.min(FILE_SYNC_CONCURRENCY, batch.length) }, () => fileWorker()),
        );
      } finally {
        signal?.removeEventListener("abort", onOuterAbort);
      }

      pendingQueue = nextRetry;
      if (pendingQueue.length > 0 && attempt < MAX_PREPARE_RETRIES && !revoked && !paused && !budgetReached && !signal?.aborted) {
        await sleep(Math.min(maxRetryMs, 1500), signal);
      }
    }

    filesPending = pendingQueue.length;

    if (revoked) {
      await wipeAllOnRevoke(db);
      return { status: "revoked" };
    }
    if (paused) {
      await db.setMeta({
        ...meta,
        thumbCount: cachedThumbCount,
        fileTotal: filesTotal,
        fileCount: cachedFileCount,
        fileBytes: cachedFileBytes,
        filePending: filesPending,
      });
      return { status: "paused", done: filesDone, total: filesTotal, reason: pauseReason };
    }
    if (signal?.aborted) {
      await db.setMeta({
        ...meta,
        thumbCount: cachedThumbCount,
        fileTotal: filesTotal,
        fileCount: cachedFileCount,
        fileBytes: cachedFileBytes,
        filePending: filesPending,
      });
      return { status: "aborted", done: filesDone, total: filesTotal };
    }
  }

  const finalMeta: OfflineSyncMeta = {
    ...meta,
    lastSyncedAt: Date.now(),
    thumbCount: cachedThumbCount,
    fileTotal: filesTotal,
    fileCount: cachedFileCount,
    fileBytes: cachedFileBytes,
    filePending: filesPending,
  };
  await db.setMeta(finalMeta);
  recordAutoSync(finalMeta.lastSyncedAt);
  return {
    status: "done",
    meta: finalMeta,
    cached: cachedThumbCount,
    skipped: skippedThumbCount,
    total,
    filesCached: cachedFileCount,
    filesTotal,
    filesBytes: cachedFileBytes,
    filesPending,
  };
}
