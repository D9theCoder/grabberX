import "server-only";
import { readdir, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mediaKindOf } from "@/components/gallery/types";
import type { FolderListing, MediaFile, MediaFolder } from "@/components/gallery/types";
import { isDeviceName, isReserved, isValidFolderName, resolveAccountDir } from "@/server/paths";
import { getSettings } from "@/server/store";

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
};

export function mimeTypeOf(name: string): string | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME[extension] ?? null;
}

export class MediaPathError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

// Letters, digits and the punctuation gallery-dl puts in names. Rejects separators, drive colons,
// wildcards and control characters, which is what traversal and Windows device tricks need.
const SEGMENT = /^[A-Za-z0-9 _.\-()[\]@+,=~]{1,200}$/;

function isValidSegment(segment: string): boolean {
  if (!SEGMENT.test(segment)) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  if (segment.startsWith(".")) return false;
  return !isDeviceName(segment);
}

/** Splits a relative path from a query string. An empty string is the account folder itself. */
export function parseRelativePath(raw: string): string[] {
  if (raw === "") return [];
  if (raw.includes("\\") || raw.startsWith("/") || isAbsolute(raw)) {
    throw new MediaPathError("That path isn't valid.", 400);
  }
  const segments = raw.split("/");
  for (const segment of segments) {
    if (!isValidSegment(segment)) throw new MediaPathError("That path isn't valid.", 400);
  }
  return segments;
}

function isInsideDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep);
}

/**
 * Turns (account, relative path) into an absolute path that is guaranteed to sit inside that account's
 * folder. Throws instead of returning anything outside it, including through a symlink.
 */
export async function resolveMediaPath(
  mediaRoot: string,
  account: string,
  rawPath: string,
): Promise<{ accountDir: string; full: string; segments: string[] }> {
  if (!isValidFolderName(account) || isReserved(account)) {
    throw new MediaPathError("That account isn't valid.", 400);
  }
  const segments = parseRelativePath(rawPath);
  let accountDir: string;
  try {
    accountDir = resolveAccountDir(mediaRoot, account);
  } catch {
    throw new MediaPathError("That account isn't valid.", 400);
  }
  const full = resolve(accountDir, ...segments);
  if (segments.length > 0 && !isInsideDir(full, accountDir)) {
    throw new MediaPathError("That path isn't valid.", 400);
  }
  const real = await realpath(full).catch(() => null);
  if (real === null) throw new MediaPathError("That file doesn't exist.", 404);
  const realAccount = await realpath(accountDir).catch(() => null);
  if (realAccount === null) throw new MediaPathError("That account doesn't exist.", 404);
  if (segments.length > 0 && !isInsideDir(real, realAccount)) {
    throw new MediaPathError("That path isn't valid.", 400);
  }
  return { accountDir, full, segments };
}

export type ByteRange = { start: number; end: number };

/**
 * Reads a single `Range: bytes=...` header. Returns null when the header should be ignored (absent,
 * malformed, or several ranges, which a video player never asks for) and "unsatisfiable" for a 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "unsatisfiable";
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

export function etagOf(info: { size: number; mtimeMs: number }): string {
  return `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

/** Folders and media files directly inside one account path. Everything else (sidecars, the archive) is left out. */
export async function listFolder(account: string, rawPath: string): Promise<FolderListing> {
  const settings = await getSettings();
  const { full } = await resolveMediaPath(settings.mediaRoot, account, rawPath);
  const info = await stat(full).catch(() => null);
  if (!info?.isDirectory()) throw new MediaPathError("That folder doesn't exist.", 404);

  const entries = await readdir(full, { withFileTypes: true });
  const folders: MediaFolder[] = [];
  const candidates: { name: string; kind: "image" | "video" }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isValidSegment(entry.name)) folders.push({ name: entry.name });
      continue;
    }
    const kind = entry.isFile() ? mediaKindOf(entry.name) : null;
    if (kind && isValidSegment(entry.name)) candidates.push({ name: entry.name, kind });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const files: MediaFile[] = [];
  for (let index = 0; index < candidates.length; index += 64) {
    const batch = candidates.slice(index, index + 64);
    const stats = await Promise.all(batch.map((item) => stat(join(full, item.name)).catch(() => null)));
    batch.forEach((item, position) => {
      const file = stats[position];
      if (file) files.push({ name: item.name, size: file.size, mtimeMs: file.mtimeMs, kind: item.kind });
    });
  }
  return { folders, files };
}

/** A media file's absolute path plus its stat, for the file route and the details panel. */
export async function statMediaFile(account: string, rawPath: string) {
  const settings = await getSettings();
  const resolved = await resolveMediaPath(settings.mediaRoot, account, rawPath);
  const name = resolved.segments.at(-1);
  if (name === undefined || mediaKindOf(name) === null) {
    throw new MediaPathError("That isn't a media file.", 400);
  }
  const info = await stat(resolved.full).catch(() => null);
  if (!info?.isFile()) throw new MediaPathError("That file doesn't exist.", 404);
  return { full: resolved.full, name, info };
}

/** Permanent delete, for `npm run dev`. The packaged app moves files to the Recycle Bin from the shell instead. */
export async function deleteMediaFile(account: string, rawPath: string): Promise<void> {
  const { full } = await statMediaFile(account, rawPath);
  await unlink(full);
}
