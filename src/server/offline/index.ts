import "server-only";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { mediaKindOf } from "@/components/gallery/types";
import type { MediaFile } from "@/components/gallery/types";
import {
  compareOfflineNewestFirst,
  estimateDerivativeBytes,
  imagePresetId,
  isAccountIncluded,
  isCopyEnabledForKind,
  isKindIncluded,
  offlineFileId,
  offlineRelPath,
  presetIdForKind,
  videoPresetId,
} from "@/lib/offline";
import type {
  OfflineEstimate,
  OfflineIndexAccount,
  OfflineIndexFile,
  OfflineIndexResponse,
  OfflineSettings,
} from "@/lib/offline";
import { listAccounts } from "@/server/library";
import { knownMeta } from "@/server/media-index";
import {
  ensureDerivativeCacheLoaded,
  getCachedDerivativeSync,
  getDerivativesRevision,
  offlineDerivativeKey,
  onOfflineDerivativeChange,
} from "@/server/offline/derivatives";
import { getOfflineSettings } from "@/server/offline/settings";
import { isDeviceName, resolveAccountDir } from "@/server/paths";
import { getSettings } from "@/server/store";
import { folderChanges } from "@/server/warm-signal";

const STAT_BATCH = 64;
const ACCOUNT_SCAN_CONCURRENCY = 4;
const SNAPSHOT_HISTORY_LIMIT = 8;
const EST_THUMB_BYTES = 20 * 1024;
const FORBIDDEN_SEGMENT_CHARS = /[\\/:*?"<>|%\x00-\x1f\x7f]/;

interface RawAccountFile {
  id: string;
  account: string;
  folder: string;
  filename: string;
  kind: "image" | "video";
  size: number;
  mtime: number;
  v: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface RawAccountCacheEntry {
  dirSig: string;
  files: RawAccountFile[];
}

export interface OfflineIndexSnapshot {
  signature: string;
  version: string;
  generatedAt: string;
  accounts: OfflineIndexAccount[];
  files: OfflineIndexFile[];
  byId: Map<string, { fingerprint: string; file: OfflineIndexFile }>;
}

interface OfflineIndexCacheState {
  current: OfflineIndexSnapshot | null;
  history: Map<string, OfflineIndexSnapshot>;
  rawAccounts: Map<string, RawAccountCacheEntry>;
  generation: number;
  subscribed: boolean;
}

const INDEX_CACHE_KEY = Symbol.for("gather.offline.index");

function cacheState(): OfflineIndexCacheState {
  const holder = globalThis as unknown as Record<symbol, OfflineIndexCacheState | undefined>;
  const state = (holder[INDEX_CACHE_KEY] ??= {
    current: null,
    history: new Map(),
    rawAccounts: new Map(),
    generation: 0,
    subscribed: false,
  });
  // Upgrade existing globalThis cache object cleanly across Next dev hot reloads.
  state.rawAccounts ??= new Map();
  if (!state.subscribed) {
    state.subscribed = true;
    folderChanges.on("changed", () => {
      state.generation += 1;
      state.current = null;
      state.rawAccounts.clear();
    });
    onOfflineDerivativeChange(() => {
      state.generation += 1;
      state.current = null;
    });
  }
  return state;
}

/** Drops the cached index snapshot and raw account listings (called on disk changes or in tests). */
export function invalidateOfflineIndex(): void {
  const state = cacheState();
  state.generation += 1;
  state.current = null;
  state.rawAccounts.clear();
}

/**
 * Drops only the filtered index snapshot when offline settings change.
 * Keeps `rawAccounts` (which is already keyed by directory mtime signatures) so toggling
 * settings recomputes estimates in milliseconds without re-walking gigabytes of media on disk.
 */
export function invalidateOfflineSettingsView(): void {
  const state = cacheState();
  state.generation += 1;
  state.current = null;
}

/** Clears current cache, raw account file cache, and incremental snapshot history (tests). */
export function resetOfflineIndexCache(): void {
  const state = cacheState();
  state.generation += 1;
  state.current = null;
  state.rawAccounts.clear();
  state.history.clear();
}

function isValidSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 200) return false;
  if (FORBIDDEN_SEGMENT_CHARS.test(segment)) return false;
  if (segment === "." || segment === ".." || segment.startsWith(".")) return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  return !isDeviceName(segment);
}

async function mtimeMsOrZero(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  return info ? Math.floor(info.mtimeMs) : 0;
}

async function directoryMtimeSignature(dir: string, depth = 0): Promise<string[]> {
  const parts: string[] = [String(await mtimeMsOrZero(dir))];
  if (depth >= 2) return parts;
  const entries = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch(() => []);
  const subdirs = entries
    .filter((entry) => entry.isDirectory() && isValidSegment(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of subdirs) {
    const childParts = await directoryMtimeSignature(join(/*turbopackIgnore: true*/ dir, name), depth + 1);
    parts.push(`${name}:${childParts.join(",")}`);
  }
  return parts;
}

function fileFingerprint(file: OfflineIndexFile): string {
  const copy = file.offline
    ? `${file.offline.preset}:${file.offline.ready ? 1 : 0}:${file.offline.bytes}`
    : "";
  return `${file.v}|${file.width ?? ""}|${file.height ?? ""}|${file.duration ?? ""}|${copy}`;
}

async function walkRawFolderFiles(
  account: string,
  baseDir: string,
  relFolder: string,
  out: RawAccountFile[],
): Promise<void> {
  const dir = relFolder ? join(/*turbopackIgnore: true*/ baseDir, ...relFolder.split("/")) : baseDir;
  const entries = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch(() => []);
  const subdirs: string[] = [];
  const candidates: { name: string; kind: "image" | "video" }[] = [];

  for (const entry of entries) {
    if (!isValidSegment(entry.name)) continue;
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    const kind = mediaKindOf(entry.name);
    if (kind) {
      candidates.push({ name: entry.name, kind });
    }
  }

  subdirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const mediaFiles: MediaFile[] = [];
  for (let i = 0; i < candidates.length; i += STAT_BATCH) {
    const batch = candidates.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(
      batch.map((item) => stat(join(/*turbopackIgnore: true*/ dir, item.name)).catch(() => null)),
    );
    batch.forEach((item, idx) => {
      const info = stats[idx];
      if (info?.isFile()) {
        mediaFiles.push({ name: item.name, size: info.size, mtimeMs: info.mtimeMs, kind: item.kind });
      }
    });
  }

  if (mediaFiles.length > 0) {
    // Reuse the existing `.gather/index/` metadata cache without opening any media file.
    const meta = await knownMeta(dir, mediaFiles);
    mediaFiles.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const file of mediaFiles) {
      const mtime = Math.floor(file.mtimeMs);
      const dims = meta.dimensions[file.name];
      const duration = meta.durations[file.name];
      out.push({
        id: offlineFileId(account, relFolder, file.name),
        account,
        folder: relFolder,
        filename: file.name,
        kind: file.kind,
        size: file.size,
        mtime,
        v: `${file.size.toString(16)}-${mtime.toString(16)}`,
        ...(dims ? { width: dims[0], height: dims[1] } : {}),
        ...(duration !== undefined ? { duration } : {}),
      });
    }
  }

  for (const sub of subdirs) {
    const nextRel = relFolder ? `${relFolder}/${sub}` : sub;
    await walkRawFolderFiles(account, baseDir, nextRel, out);
  }
}

async function getRawAccountFiles(
  account: string,
  dir: string,
  dirSig: string,
): Promise<RawAccountFile[]> {
  const state = cacheState();
  const cached = state.rawAccounts.get(dir);
  if (cached && cached.dirSig === dirSig) {
    return cached.files;
  }
  const files: RawAccountFile[] = [];
  await walkRawFolderFiles(account, dir, "", files);
  state.rawAccounts.set(dir, { dirSig, files });
  return files;
}

function computeVersion(accounts: OfflineIndexAccount[], files: OfflineIndexFile[], settings: OfflineSettings): string {
  const hash = createHash("sha256");
  hash.update(
    `v2|${settings.includeImages ? 1 : 0}|${settings.includeVideos ? 1 : 0}|${settings.selection}:${settings.newestCount}|${settings.phoneBudgetMB}|${settings.image.enabled ? imagePresetId(settings.image) : "off"}|${settings.video.enabled ? videoPresetId(settings.video) : "off"}|`,
  );
  for (const account of accounts) {
    hash.update(`A:${account.folder}:${account.layout}:${account.lastRunAt ?? ""}\n`);
  }
  for (const file of files) {
    hash.update(`F:${file.id}:${fileFingerprint(file)}\n`);
  }
  return hash.digest("hex").slice(0, 24);
}

export async function getOfflineIndexSnapshot(offlineSettings: OfflineSettings): Promise<OfflineIndexSnapshot> {
  const state = cacheState();
  await ensureDerivativeCacheLoaded();
  const appSettings = await getSettings();
  const allAccounts = await listAccounts();
  const included = allAccounts.filter((entry) => isAccountIncluded(offlineSettings, entry.folder));

  // Lightweight signature check: directory mtimes + settings + derivative revision.
  const sigParts: string[] = [
    String(state.generation),
    String(getDerivativesRevision()),
    appSettings.mediaRoot,
    JSON.stringify(offlineSettings),
    String(await mtimeMsOrZero(appSettings.mediaRoot)),
  ];
  const resolvedDirs: { entry: (typeof included)[number]; dir: string; dirSig: string }[] = [];
  for (const entry of included) {
    try {
      const dir = resolveAccountDir(appSettings.mediaRoot, entry.folder);
      const dirSig = (await directoryMtimeSignature(dir)).join(";");
      resolvedDirs.push({ entry, dir, dirSig });
      sigParts.push(`${entry.folder}=${entry.lastRunAt ?? ""}|${dirSig}`);
    } catch {
      /* ignore invalid folder */
    }
  }
  const signature = sigParts.join("\n");
  if (state.current && state.current.signature === signature) {
    return state.current;
  }

  // Load raw per-account listings (from mtime-keyed memory cache when warm; bounded concurrency when cold).
  const rawPerAccount: RawAccountFile[][] = new Array(resolvedDirs.length);
  let cursor = 0;
  async function scanWorker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= resolvedDirs.length) return;
      const item = resolvedDirs[idx]!;
      rawPerAccount[idx] = await getRawAccountFiles(item.entry.folder, item.dir, item.dirSig);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ACCOUNT_SCAN_CONCURRENCY, Math.max(1, resolvedDirs.length)) }, () => scanWorker()),
  );

  const accounts: OfflineIndexAccount[] = [];
  const files: OfflineIndexFile[] = [];

  for (let i = 0; i < resolvedDirs.length; i += 1) {
    const { entry } = resolvedDirs[i]!;
    const rawFiles = rawPerAccount[i] ?? [];
    const matchingKind = rawFiles.filter((f) => isKindIncluded(offlineSettings, f.kind));
    const keptRaw =
      offlineSettings.selection === "newest"
        ? [...matchingKind].sort(compareOfflineNewestFirst).slice(0, offlineSettings.newestCount)
        : matchingKind;

    let images = 0;
    let videos = 0;
    let bytes = 0;
    for (const raw of keptRaw) {
      const item: OfflineIndexFile = { ...raw };
      if (isCopyEnabledForKind(offlineSettings, raw.kind)) {
        const preset = presetIdForKind(raw.kind, offlineSettings);
        const rel = offlineRelPath(raw.folder, raw.filename);
        const key = offlineDerivativeKey(raw.account, rel, raw.v, preset);
        const cached = getCachedDerivativeSync(key);
        item.offline = {
          bytes: cached ? cached.size : estimateDerivativeBytes(item, offlineSettings),
          ready: cached !== null,
          preset,
        };
      }
      files.push(item);
      if (raw.kind === "image") images += 1;
      else videos += 1;
      bytes += raw.size;
    }

    accounts.push({
      folder: entry.folder,
      layout: entry.layout,
      ...(entry.lastRunAt ? { lastRunAt: entry.lastRunAt } : {}),
      imageCount: images,
      videoCount: videos,
      totalBytes: bytes,
    });
  }

  const version = computeVersion(accounts, files, offlineSettings);
  const byId = new Map<string, { fingerprint: string; file: OfflineIndexFile }>();
  for (const file of files) {
    byId.set(file.id, { fingerprint: fileFingerprint(file), file });
  }

  const snapshot: OfflineIndexSnapshot = {
    signature,
    version,
    generatedAt: new Date().toISOString(),
    accounts,
    files,
    byId,
  };

  state.current = snapshot;
  state.history.delete(version);
  state.history.set(version, snapshot);
  while (state.history.size > SNAPSHOT_HISTORY_LIMIT) {
    const oldest = state.history.keys().next().value;
    if (oldest !== undefined) state.history.delete(oldest);
  }

  return snapshot;
}

/** Checks whether `(account, relPath)` is included in the active selection (handles `selection: "newest"`). */
export async function isFileInOfflineSelection(
  account: string,
  relPath: string,
  settings: OfflineSettings,
): Promise<boolean> {
  if (!isAccountIncluded(settings, account)) return false;
  if (settings.selection === "all") return true;
  const snapshot = await getOfflineIndexSnapshot(settings);
  const targetId = `${account}/${relPath}`;
  if (snapshot.byId.has(targetId)) return true;
  const lowerTarget = targetId.toLowerCase();
  for (const id of snapshot.byId.keys()) {
    if (id.toLowerCase() === lowerTarget) return true;
  }
  return false;
}

/** Computes a server-side storage estimate for the Settings → Offline on phone summary line. */
export async function getOfflineEstimate(settings?: OfflineSettings): Promise<OfflineEstimate> {
  const effective = settings ?? (await getOfflineSettings());
  const snapshot = await getOfflineIndexSnapshot(effective);
  let imageCount = 0;
  let videoCount = 0;
  let estimatedBytes = snapshot.files.length * EST_THUMB_BYTES;
  let cachedCount = 0;
  let cachedBytes = 0;

  for (const file of snapshot.files) {
    if (!file.offline) continue;
    if (file.kind === "image") imageCount += 1;
    else videoCount += 1;
    estimatedBytes += file.offline.bytes;
    if (file.offline.ready) {
      cachedCount += 1;
      cachedBytes += file.offline.bytes;
    }
  }

  const phoneBudgetBytes = effective.phoneBudgetMB * 1024 * 1024;
  return {
    imageCount,
    videoCount,
    thumbCount: snapshot.files.length,
    estimatedBytes,
    cachedCount,
    cachedBytes,
    overPhoneBudget: estimatedBytes > phoneBudgetBytes,
  };
}

export function normalizeEtag(header: string | undefined | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const unweak = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  return unweak.replace(/^"|"$/g, "") || null;
}

export interface BuildOfflineIndexOptions {
  ifNoneMatch?: string | null;
  since?: string | null;
}

export type OfflineIndexResult =
  | { notModified: true; etag: string; version: string }
  | { notModified: false; etag: string; payload: OfflineIndexResponse };

function presetFields(settings: OfflineSettings): {
  phoneBudgetBytes: number;
  imagePreset?: string;
  videoPreset?: string;
} {
  return {
    phoneBudgetBytes: settings.phoneBudgetMB * 1024 * 1024,
    ...(settings.includeImages && settings.image.enabled ? { imagePreset: imagePresetId(settings.image) } : {}),
    ...(settings.includeVideos && settings.video.enabled ? { videoPreset: videoPresetId(settings.video) } : {}),
  };
}

export async function buildOfflineIndex(options: BuildOfflineIndexOptions = {}): Promise<OfflineIndexResult> {
  const offlineSettings = await getOfflineSettings();
  const match = normalizeEtag(options.ifNoneMatch);

  if (!offlineSettings.enabled) {
    const version = "disabled";
    const etag = `"${version}"`;
    if (match === version) {
      return { notModified: true, etag, version };
    }
    return {
      notModified: false,
      etag,
      payload: {
        ok: true,
        enabled: false,
        version,
        generatedAt: new Date().toISOString(),
        incremental: false,
        accounts: [],
        files: [],
        totalFiles: 0,
        phoneBudgetBytes: offlineSettings.phoneBudgetMB * 1024 * 1024,
      },
    };
  }

  const snapshot = await getOfflineIndexSnapshot(offlineSettings);
  const etag = `"${snapshot.version}"`;
  const presets = presetFields(offlineSettings);

  if (match === snapshot.version) {
    return { notModified: true, etag, version: snapshot.version };
  }

  const since = options.since?.trim() || null;
  if (since && since === snapshot.version) {
    return {
      notModified: false,
      etag,
      payload: {
        ok: true,
        enabled: true,
        version: snapshot.version,
        generatedAt: snapshot.generatedAt,
        incremental: true,
        accounts: snapshot.accounts,
        files: [],
        removed: [],
        totalFiles: snapshot.files.length,
        ...presets,
      },
    };
  }

  const previous = since ? cacheState().history.get(since) : undefined;
  if (previous) {
    const changed: OfflineIndexFile[] = [];
    for (const [id, entry] of snapshot.byId) {
      const old = previous.byId.get(id);
      if (!old || old.fingerprint !== entry.fingerprint) {
        changed.push(entry.file);
      }
    }
    const removed: string[] = [];
    for (const id of previous.byId.keys()) {
      if (!snapshot.byId.has(id)) removed.push(id);
    }
    return {
      notModified: false,
      etag,
      payload: {
        ok: true,
        enabled: true,
        version: snapshot.version,
        generatedAt: snapshot.generatedAt,
        incremental: true,
        accounts: snapshot.accounts,
        files: changed,
        removed,
        totalFiles: snapshot.files.length,
        ...presets,
      },
    };
  }

  return {
    notModified: false,
    etag,
    payload: {
      ok: true,
      enabled: true,
      version: snapshot.version,
      generatedAt: snapshot.generatedAt,
      incremental: false,
      accounts: snapshot.accounts,
      files: snapshot.files,
      totalFiles: snapshot.files.length,
      ...presets,
    },
  };
}
