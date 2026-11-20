import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaFile } from "@/components/gallery/types";
import { readImageSize } from "@/server/image-size";
import { gatherHome } from "@/server/store";
import { readDimensions } from "@/server/thumbs";

/**
 * What the gallery needs before it can lay out a folder: each image's size and each video's length.
 * Kept on disk per folder in `.gather/index/`, so a folder opens with its layout ready even after a restart.
 * An entry is valid only while the file's size and modified time match.
 */
interface Entry {
  s: number;
  m: number;
  w?: number;
  h?: number;
  /** Video length in seconds, reported by the browser or extracted by the ffmpeg warmer. */
  d?: number;
}

interface FolderIndex {
  v: 1;
  entries: Record<string, Entry>;
}

export interface FolderMeta {
  dimensions: Record<string, [number, number]>;
  durations: Record<string, number>;
  /** Images whose size isn't known yet. */
  missing: number;
}

const MEMORY_MAX = 64;
const SAVE_DELAY_MS = 1500;
const CONCURRENCY = 8;

// Next can load this module in more than one chunk. The memory map and pending timers live on globalThis so
// the warmer, the media routes and the pages see one index, as the mobile gateway state does.
interface IndexState {
  memory: Map<string, FolderIndex>;
  pendingSaves: Map<string, { timer: ReturnType<typeof setTimeout>; folder: string; index: FolderIndex }>;
  writeChains: Map<string, Promise<void>>;
  tempCounter: number;
}

const INDEX_STATE = Symbol.for("gather.media-index");

function indexState(): IndexState {
  const holder = globalThis as unknown as Record<symbol, IndexState | undefined>;
  return (holder[INDEX_STATE] ??= {
    memory: new Map(),
    pendingSaves: new Map(),
    writeChains: new Map(),
    tempCounter: 0,
  });
}

function folderCacheKey(folder: string): string {
  return process.platform === "win32" ? folder.toLowerCase() : folder;
}

function indexDir(): string {
  return join(gatherHome(), "index");
}

function indexFile(folder: string): string {
  const key = createHash("sha1").update(folder.toLowerCase()).digest("hex");
  return join(indexDir(), `${key}.json`);
}

async function load(folder: string): Promise<FolderIndex> {
  const memory = indexState().memory;
  const key = folderCacheKey(folder);
  const cached = memory.get(key);
  if (cached) {
    memory.delete(key);
    memory.set(key, cached);
    return cached;
  }
  let index: FolderIndex = { v: 1, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(indexFile(folder), "utf8")) as FolderIndex;
    if (parsed?.v === 1 && parsed.entries && typeof parsed.entries === "object") index = parsed;
  } catch {
    /* no index yet */
  }
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, index);
  return index;
}

function scheduleSave(folder: string, index: FolderIndex) {
  const state = indexState();
  const key = folderCacheKey(folder);
  const existing = state.pendingSaves.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    state.pendingSaves.delete(key);
    void persist(folder, index).catch((error: unknown) => console.error("grabberX: could not save the media index.", error));
  }, SAVE_DELAY_MS);
  timer.unref?.();
  state.pendingSaves.set(key, { timer, folder, index });
}

function persist(folder: string, index: FolderIndex): Promise<void> {
  const state = indexState();
  const key = folderCacheKey(folder);
  const payload = JSON.stringify(index);
  const previous = state.writeChains.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(indexDir(), { recursive: true });
      const file = indexFile(folder);
      state.tempCounter += 1;
      const temp = `${file}.${process.pid}.${state.tempCounter}.tmp`;
      await writeFile(temp, payload);
      await rename(temp, file).catch(() => rm(temp, { force: true }));
    });
  state.writeChains.set(key, next);
  return next;
}

/** Flushes all pending debounced media-index writes to disk (used on clean shutdown). */
export async function flushMediaIndex(): Promise<void> {
  const state = indexState();
  const pending = [...state.pendingSaves.entries()];
  state.pendingSaves.clear();
  const tasks: Promise<void>[] = [];
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    tasks.push(
      persist(entry.folder, entry.index).catch((error: unknown) => {
        console.error("grabberX: could not flush the media index.", error);
      }),
    );
  }
  tasks.push(...[...state.writeChains.values()].map((p) => p.catch(() => {})));
  await Promise.all(tasks);
}

/** Drops in-memory cache and pending saves for a folder tree (e.g. after moving/renaming an account folder). */
export function invalidateMediaIndex(dirPrefix: string): void {
  const state = indexState();
  const prefix = folderCacheKey(dirPrefix).replace(/[\\/]+$/, "");
  const matches = (key: string) =>
    key === prefix || key.startsWith(`${prefix}\\`) || key.startsWith(`${prefix}/`);
  for (const key of [...state.memory.keys()]) {
    if (matches(key)) state.memory.delete(key);
  }
  for (const [key, entry] of [...state.pendingSaves.entries()]) {
    if (matches(key)) {
      clearTimeout(entry.timer);
      state.pendingSaves.delete(key);
    }
  }
}

function fresh(entry: Entry | undefined, file: MediaFile): entry is Entry {
  return entry !== undefined && entry.s === file.size && entry.m === Math.floor(file.mtimeMs);
}

function collect(index: FolderIndex, files: readonly MediaFile[]): FolderMeta {
  const meta: FolderMeta = { dimensions: {}, durations: {}, missing: 0 };
  for (const file of files) {
    const entry = index.entries[file.name];
    if (!fresh(entry, file)) {
      if (file.kind === "image") meta.missing += 1;
      continue;
    }
    if (entry.w && entry.h) meta.dimensions[file.name] = [entry.w, entry.h];
    if (entry.d) meta.durations[file.name] = entry.d;
  }
  return meta;
}

/** What the index already knows, without reading any file. For the first render of a folder. */
export async function knownMeta(folder: string, files: readonly MediaFile[]): Promise<FolderMeta> {
  return collect(await load(folder), files);
}

/** Fills in every image size the index is missing, then returns the whole folder's metadata. */
export async function completeMeta(folder: string, files: readonly MediaFile[]): Promise<FolderMeta> {
  const index = await load(folder);
  const todo = files.filter((file) => file.kind === "image" && !fresh(index.entries[file.name], file));
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const file = todo[next++]!;
      const full = join(folder, file.name);
      const size = (await readImageSize(full)) ?? (await readDimensions(full));
      const previous = index.entries[file.name];
      index.entries[file.name] = {
        s: file.size,
        m: Math.floor(file.mtimeMs),
        ...(size ? { w: size[0], h: size[1] } : {}),
        ...(previous?.d ? { d: previous.d } : {}),
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  // Files that are gone take their entries with them, so an index never outgrows its folder.
  const names = new Set(files.map((file) => file.name));
  let dropped = false;
  for (const name of Object.keys(index.entries)) {
    if (!names.has(name)) {
      delete index.entries[name];
      dropped = true;
    }
  }
  if (todo.length > 0 || dropped) scheduleSave(folder, index);
  return collect(index, files);
}

export async function recordDuration(folder: string, file: MediaFile, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60 * 60 * 24) return;
  const index = await load(folder);
  const entry = index.entries[file.name];
  const base: Entry = fresh(entry, file) ? entry : { s: file.size, m: Math.floor(file.mtimeMs) };
  index.entries[file.name] = { ...base, d: Math.round(seconds * 10) / 10 };
  scheduleSave(folder, index);
}

/** For tests: forget everything held in memory. */
export function resetMediaIndexMemory(): void {
  const state = indexState();
  state.memory.clear();
  for (const entry of state.pendingSaves.values()) clearTimeout(entry.timer);
  state.pendingSaves.clear();
  state.writeChains.clear();
}
