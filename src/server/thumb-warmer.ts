import "server-only";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { mediaKindOf } from "@/components/gallery/types";
import type { MediaFile } from "@/components/gallery/types";
import { listAccounts } from "@/server/library";
import { completeMeta } from "@/server/media-index";
import { resolveAccountDir } from "@/server/paths";
import { getSettings } from "@/server/store";
import { getThumbnail, hasThumbnail, thumbnailsBusy } from "@/server/thumbs";
import { folderChanges } from "@/server/warm-signal";

/**
 * Builds image sizes and 480 px thumbnails in the background, one image at a time, so an account's gallery
 * opens with everything cached. It runs after each download and once shortly after start, and it steps aside
 * whenever the grid is asking for thumbnails itself.
 */

const START_DELAY_MS = 15_000;
const BUSY_WAIT_MS = 300;
const SESSION_BUDGET_BYTES = 768 * 1024 * 1024;

const queue: string[] = [];
let running = false;
let started = false;
let warmedBytes = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueue(dir: string) {
  if (!queue.includes(dir)) queue.push(dir);
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0 && warmedBytes < SESSION_BUDGET_BYTES) {
      await warmTree(queue.shift()!);
    }
  } catch (error) {
    console.error("gather: the thumbnail warm-up stopped.", error);
  } finally {
    running = false;
  }
}

async function warmTree(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: MediaFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      await warmTree(join(dir, entry.name));
      continue;
    }
    const kind = entry.isFile() ? mediaKindOf(entry.name) : null;
    if (!kind) continue;
    const info = await stat(join(dir, entry.name)).catch(() => null);
    if (info) files.push({ name: entry.name, size: info.size, mtimeMs: info.mtimeMs, kind });
  }
  if (files.length === 0) return;
  await completeMeta(dir, files);
  // Newest first: those are what the gallery shows at the top.
  const images = files.filter((file) => file.kind === "image").sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  for (const file of images) {
    if (warmedBytes >= SESSION_BUDGET_BYTES) return;
    const full = join(dir, file.name);
    if (await hasThumbnail(full, 480, file)) continue;
    while (thumbnailsBusy()) await sleep(BUSY_WAIT_MS);
    const bytes = await getThumbnail(full, 480, file, "idle");
    if (bytes) warmedBytes += bytes.length;
  }
}

export function startThumbWarmer(): void {
  if (started || process.env.GATHER_NO_WARM === "1") return;
  started = true;
  folderChanges.on("changed", (dir: string) => enqueue(dir));
  setTimeout(() => {
    void (async () => {
      const settings = await getSettings();
      for (const account of await listAccounts()) {
        try {
          enqueue(resolveAccountDir(settings.mediaRoot, account.folder));
        } catch {
          /* not an account folder */
        }
      }
    })().catch((error: unknown) => console.error("gather: could not start the thumbnail warm-up.", error));
  }, START_DELAY_MS).unref();
}
