import "server-only";
import { join } from "node:path";
import { compareOfflineNewestFirst, isCopyEnabledForKind, offlineRelPath } from "@/lib/offline";
import {
  enqueueOfflineDerivative,
  getCachedOfflineDerivative,
  getOfflineDerivativeScheduler,
  pruneOfflineFilesCache,
  stopOfflineDerivatives,
} from "@/server/offline/derivatives";
import { getOfflineIndexSnapshot } from "@/server/offline/index";
import { getOfflineSettings } from "@/server/offline/settings";
import { resolveAccountDir } from "@/server/paths";
import { getSettings } from "@/server/store";
import { folderChanges } from "@/server/warm-signal";

const START_DELAY_MS = 20_000;

interface PreloaderState {
  started: boolean;
  generation: number;
  running: boolean;
}

const PRELOADER_STATE_KEY = Symbol.for("gather.offline.preloader");

function preloaderState(): PreloaderState {
  const holder = globalThis as unknown as Record<symbol, PreloaderState | undefined>;
  return (holder[PRELOADER_STATE_KEY] ??= {
    started: false,
    generation: 0,
    running: false,
  });
}

/**
 * Walks the selected offline set newest-first and queues uncached Layer 3 derivatives for background
 * preparation whenever `enabled && prepareInBackground` is on. Stops if settings change or cache budget fills.
 */
export async function runOfflineBackgroundPrep(): Promise<void> {
  const state = preloaderState();
  const runGen = ++state.generation;
  const offlineSettings = await getOfflineSettings();
  if (!offlineSettings.enabled || !offlineSettings.prepareInBackground) return;
  if (state.running) return;
  state.running = true;

  try {
    const [appSettings, snapshot] = await Promise.all([
      getSettings(),
      getOfflineIndexSnapshot(offlineSettings),
    ]);
    if (state.generation !== runGen) return;

    const candidates = snapshot.files
      .filter((file) => isCopyEnabledForKind(offlineSettings, file.kind))
      .sort(compareOfflineNewestFirst);

    const cacheBudget = offlineSettings.pcCacheMB * 1024 * 1024;
    let plannedBytes = 0;

    for (const file of candidates) {
      if (state.generation !== runGen) break;
      const latest = await getOfflineSettings();
      if (!latest.enabled || !latest.prepareInBackground) break;

      const relPath = offlineRelPath(file.folder, file.filename);
      const cached = await getCachedOfflineDerivative(file.account, relPath, file.v, file.kind, latest);
      if (cached) {
        plannedBytes += cached.size;
        if (plannedBytes >= cacheBudget) break;
        continue;
      }

      const estimated = file.offline?.bytes ?? 0;
      if (plannedBytes + estimated > cacheBudget && plannedBytes > 0) break;

      let fullPath: string;
      try {
        const accountDir = resolveAccountDir(appSettings.mediaRoot, file.account);
        fullPath = join(accountDir, ...relPath.split("/"));
      } catch {
        continue;
      }

      const result = await enqueueOfflineDerivative(
        {
          account: file.account,
          relPath,
          fullPath,
          kind: file.kind,
          size: file.size,
          mtimeMs: file.mtime,
          v: file.v,
          settings: latest,
        },
        { priority: false },
      );
      if (result) plannedBytes += result.size;
    }
  } catch (error) {
    console.error("grabberX: background offline preparation stopped.", error);
  } finally {
    state.running = false;
  }
}

/** Called when offline settings change: cancels obsolete work, prunes PC cache, and restarts background prep if on. */
export async function handleOfflineSettingsChanged(): Promise<void> {
  const state = preloaderState();
  state.generation += 1;
  stopOfflineDerivatives();
  const settings = await getOfflineSettings();
  void pruneOfflineFilesCache(settings.pcCacheMB * 1024 * 1024).catch(() => {});
  if (settings.enabled && settings.prepareInBackground && process.env.GATHER_NO_WARM !== "1") {
    void runOfflineBackgroundPrep();
  }
}

export function startOfflinePreloader(): void {
  const state = preloaderState();
  if (state.started || process.env.GATHER_NO_WARM === "1") return;
  state.started = true;

  folderChanges.on("changed", () => {
    if (getOfflineDerivativeScheduler().pendingCount === 0) {
      void runOfflineBackgroundPrep();
    }
  });

  setTimeout(() => {
    void runOfflineBackgroundPrep();
  }, START_DELAY_MS).unref();
}
