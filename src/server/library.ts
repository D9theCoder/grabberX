import "server-only";
import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  AccountHint,
  AccountStats,
  DetectedLayout,
  LibraryEntry,
  SiteId,
} from "@/lib/spec";
import { folderNameFor, validateAccount } from "@/lib/sites";
import { isReserved, isValidFolderName, resolveAccountDir } from "@/server/paths";
import { runQueue } from "@/server/run-queue";
import { getSettings } from "@/server/store";

const STATS_CACHE_MAX = 64;
const YEAR_FOLDER = /^\d{4}$/;

const FOLDER_NAME_MESSAGE =
  "Folder names can use letters, numbers, dots, dashes and underscores, up to 64 characters.";

interface StatsCacheEntry {
  signature: string;
  stats: AccountStats;
}

const statsCache = new Map<string, StatsCacheEntry>();

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ?? false;
}

async function mtimeMsOrZero(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  return info?.mtimeMs ?? 0;
}

async function detectLayout(dir: string): Promise<DetectedLayout> {
  if (await isDirectory(join(dir, "Image"))) {
    const entries = await readdir(join(dir, "Image"), { withFileTypes: true }).catch(() => []);
    const hasYear = entries.some((entry) => entry.isDirectory() && YEAR_FOLDER.test(entry.name));
    return hasYear ? "byTypeYear" : "byType";
  }
  if (await isDirectory(join(dir, "Video"))) return "byType";
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const hasFiles = entries.some(
    (entry) => entry.isFile() && !entry.name.startsWith("archive.sqlite3"),
  );
  return hasFiles ? "flat" : "unknown";
}

const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v)$/i;

/**
 * The one counting rule for every layout. Counting by extension keeps `.json` sidecars (`--write-metadata`)
 * and `.part` leftovers out, so a by-type account and a flat account with the same media report the same
 * numbers.
 */
async function walkByExtension(dir: string): Promise<AccountStats> {
  const totals: AccountStats = { images: 0, videos: 0, bytes: 0 };
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkByExtension(full);
      totals.images += nested.images;
      totals.videos += nested.videos;
      totals.bytes += nested.bytes;
      continue;
    }
    const isImage = IMAGE_EXTENSION.test(entry.name);
    if (!entry.isFile() || (!isImage && !VIDEO_EXTENSION.test(entry.name))) continue;
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (isImage) totals.images += 1;
    else totals.videos += 1;
    totals.bytes += info.size;
  }
  return totals;
}

/** A new file only bumps the mtime of the folder that holds it, so year subfolders must be part of the key. */
async function subfolderMtimes(dir: string): Promise<number[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => mtimeMsOrZero(join(dir, entry.name))),
  );
}

async function accountStats(folder: string, dir: string): Promise<AccountStats> {
  const imageDir = join(dir, "Image");
  const videoDir = join(dir, "Video");
  const typed = (await isDirectory(imageDir)) || (await isDirectory(videoDir));

  const signature = (
    await Promise.all([
      mtimeMsOrZero(dir),
      mtimeMsOrZero(imageDir),
      mtimeMsOrZero(videoDir),
      subfolderMtimes(imageDir),
      subfolderMtimes(videoDir),
      typed ? [] : subfolderMtimes(dir),
    ])
  )
    .flat()
    .join(":");
  const cached = statsCache.get(folder);
  if (cached && cached.signature === signature) return cached.stats;

  // Typed accounts count only their Image/ and Video/ folders: the cache signature covers just those,
  // and anything else under the account folder (a manual export, a backup) is not downloaded media.
  let stats: AccountStats;
  if (typed) {
    const [images, videos] = await Promise.all([walkByExtension(imageDir), walkByExtension(videoDir)]);
    stats = {
      images: images.images + videos.images,
      videos: images.videos + videos.videos,
      bytes: images.bytes + videos.bytes,
    };
  } else {
    stats = await walkByExtension(dir);
  }

  if (statsCache.size >= STATS_CACHE_MAX) {
    const oldest = statsCache.keys().next().value;
    if (oldest !== undefined) statsCache.delete(oldest);
  }
  statsCache.set(folder, { signature, stats });
  return stats;
}

export async function listAccounts(): Promise<LibraryEntry[]> {
  const settings = await getSettings();
  const entries = await readdir(settings.mediaRoot, { withFileTypes: true }).catch(() => []);
  const accounts: LibraryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isReserved(entry.name)) continue;
    const dir = join(settings.mediaRoot, entry.name);
    const archive = await stat(join(dir, "archive.sqlite3")).catch(() => null);
    if (!archive?.isFile()) continue;
    accounts.push({
      folder: entry.name,
      lastRunAt: archive.mtime.toISOString(),
      layout: await detectLayout(dir),
    });
  }
  accounts.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
  return accounts;
}

export async function getAccountStats(folder: string): Promise<AccountStats> {
  const settings = await getSettings();
  const dir = resolveAccountDir(settings.mediaRoot, folder);
  return accountStats(folder, dir);
}

/** Windows refuses a rename while something holds the folder open (Explorer, an indexer); usually transient. */
const RENAME_BACKOFF_MS = [0, 150, 450];

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown = new Error("rename never ran");
  for (const delay of RENAME_BACKOFF_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "EPERM" && code !== "EBUSY") throw error;
    }
  }
  throw lastError;
}

/**
 * Renames an account folder inside the media root. A same-drive rename is instant even for
 * gigabytes, and the archive ledger is path-independent, so a moved account never re-downloads.
 * Throws messages meant to be shown to the user as-is.
 */
export async function moveAccountFolder(from: string, to: string): Promise<void> {
  const source = from.trim();
  const target = to.trim();
  if (source === target) {
    throw new Error(`"${target}" is already this folder's name. Type a different name.`);
  }
  if (!isValidFolderName(source) || isReserved(source)) {
    throw new Error(`"${source}" isn't a folder in the library.`);
  }
  if (!isValidFolderName(target)) throw new Error(FOLDER_NAME_MESSAGE);
  if (isReserved(target)) {
    throw new Error(`"${target}" is used by the app itself. Choose a different folder name.`);
  }

  const settings = await getSettings();
  const sourceDir = resolveAccountDir(settings.mediaRoot, source);
  const targetDir = resolveAccountDir(settings.mediaRoot, target);

  // A run writing into either name would strand its files, or reopen the old archive, on one side
  // of the move. A run caught between its enqueue claim and its queue registration could still slip
  // past this check; that window is a single request, not worth a cross-module lock yet.
  for (const folder of [source, target]) {
    if (runQueue.findActive(folder)) {
      throw new Error(
        `An update for ${folder} is queued or running. Wait for it to finish, then move again.`,
      );
    }
  }

  if (!(await isDirectory(sourceDir))) {
    throw new Error(`"${source}" isn't a folder in the library anymore. Refresh and try again.`);
  }

  // A case-only rename would trip the existence check on Windows, where asking for the target
  // finds the source. The file system treats it as a rename regardless.
  const caseOnly = source.toLowerCase() === target.toLowerCase();
  if (!caseOnly && (await isDirectory(targetDir))) {
    throw new Error(`"${target}" already exists. Choose a different folder name.`);
  }

  try {
    await renameWithRetry(sourceDir, targetDir);
  } catch (error) {
    console.error(`gather: could not move ${source} to ${target}.`, error);
    throw new Error(`"${source}" couldn't be moved. Close anything using the folder and try again.`);
  } finally {
    // Both keys, in case an earlier folder held cached stats under the target's name.
    statsCache.delete(source);
    statsCache.delete(target);
  }
}

interface FolderState {
  exists: boolean;
  lastRunAt?: string;
}

async function inspectFolder(dir: string): Promise<FolderState> {
  if (!(await isDirectory(dir))) return { exists: false };
  const archive = await stat(join(dir, "archive.sqlite3")).catch(() => null);
  if (archive?.isFile()) {
    return { exists: true, lastRunAt: archive.mtime.toISOString() };
  }
  if (await isDirectory(join(dir, "Image"))) return { exists: true };
  if (await isDirectory(join(dir, "Video"))) return { exists: true };
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const hasFiles = entries.some(
    (entry) => entry.isFile() && !entry.name.startsWith("archive.sqlite3"),
  );
  return { exists: hasFiles };
}

export async function getAccountHint(input: {
  site: SiteId;
  account: string;
  folder?: string;
}): Promise<AccountHint> {
  const account = input.account.trim();
  if (account === "") return { kind: "empty" };

  const validated = validateAccount(input.site, account);
  if (!validated.ok) return { kind: "invalid", message: validated.message };

  const override = input.folder?.trim();
  if (override && !isValidFolderName(override)) {
    return { kind: "invalid", message: FOLDER_NAME_MESSAGE };
  }
  const folder = override || folderNameFor({ site: input.site, account: validated.account });

  if (isReserved(folder)) return { kind: "reserved", folder };

  const active = runQueue.findActive(folder);
  if (active) return { kind: "active", runId: active.id };

  const settings = await getSettings();
  let dir: string;
  try {
    dir = resolveAccountDir(settings.mediaRoot, folder);
  } catch {
    return { kind: "new", folder };
  }

  const state = await inspectFolder(dir);
  if (!state.exists) return { kind: "new", folder };

  const stats = await accountStats(folder, dir);
  return {
    kind: "exists",
    folder,
    files: stats.images + stats.videos,
    bytes: stats.bytes,
    ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
    layout: await detectLayout(dir),
  };
}
