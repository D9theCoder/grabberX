import "server-only";
import { resolve, sep } from "node:path";

/** Names the app itself needs at the repo root, plus every dot-folder. */
export const RESERVED: ReadonlySet<string> = new Set([
  "src",
  "public",
  "docs",
  "node_modules",
  ".next",
  ".gather",
  ".git",
  ".agents",
  ".claude",
]);

const FOLDER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// Windows resolves these (with or without an extension) to devices, so no folder can have the name.
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function isDeviceName(name: string): boolean {
  return DEVICE_NAME.test(name);
}

export function isValidFolderName(name: string): boolean {
  if (!FOLDER_NAME.test(name)) return false;
  if (isDeviceName(name)) return false;
  if (name === "." || name === "..") return false;
  if (name.endsWith(".")) return false;
  return true;
}

export function isReserved(folder: string): boolean {
  const lower = folder.toLowerCase();
  if (lower.startsWith(".")) return true;
  return RESERVED.has(lower);
}

/** True when `dir` is strictly inside `root`. Windows paths compare case-insensitively. */
function isInside(dir: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return process.platform === "win32"
    ? dir.toLowerCase().startsWith(prefix.toLowerCase())
    : dir.startsWith(prefix);
}

function isSamePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Throws when `mediaRoot` is a place downloads must never go: somewhere an update or uninstall
 * would wipe, or somewhere that mixes media with the app's own state. `protectedDirs` are the
 * install directory and the state folder (GATHER_HOME) when the shell provides them.
 */
export function assertSafeMediaRoot(mediaRoot: string, protectedDirs: readonly string[]): void {
  const root = resolve(mediaRoot);
  for (const raw of protectedDirs) {
    const protectedDir = resolve(raw);
    if (isSamePath(root, protectedDir) || isInside(root, protectedDir)) {
      throw new Error(
        `The media folder can't be inside the app's own folder (${protectedDir}). Updates would delete it.`,
      );
    }
    if (isInside(protectedDir, root)) {
      throw new Error(
        `The media folder can't contain the app's own folder (${protectedDir}). Pick a folder dedicated to your downloads.`,
      );
    }
  }
}

/**
 * The one place a media path is turned into an absolute path. Throws instead of returning a
 * path outside `mediaRoot`, so a bad handle can never write outside the media tree.
 */
export function resolveAccountDir(mediaRoot: string, folder: string): string {
  if (!isValidFolderName(folder)) {
    throw new Error(`"${folder}" is not a valid folder name.`);
  }
  const root = resolve(mediaRoot);
  const dir = resolve(root, folder);
  if (!isInside(dir, root)) {
    throw new Error(`"${folder}" resolves outside the media folder.`);
  }
  return dir;
}
