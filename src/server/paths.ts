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
  const prefix = root.endsWith(sep) ? root : root + sep;
  const inside =
    process.platform === "win32"
      ? dir.toLowerCase().startsWith(prefix.toLowerCase())
      : dir.startsWith(prefix);
  if (!inside) {
    throw new Error(`"${folder}" resolves outside the media folder.`);
  }
  return dir;
}
