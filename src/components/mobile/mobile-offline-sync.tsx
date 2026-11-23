"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useNow } from "@/components/use-now";
import { formatBytes, formatCount, formatRelative } from "@/lib/format";
import { getOfflineDb, wipeOfflineStorage } from "@/lib/offline-db";
import type { OfflineSyncMeta } from "@/lib/offline-db";
import { getStorageUsage, runOfflineSync, shouldAutoSync } from "@/lib/offline-sync";
import type { StorageUsage, SyncProgress } from "@/lib/offline-sync";

export function MobileOfflineSync({ now: initialNow }: { now: number }) {
  const tickingNow = useNow(true, 30_000);
  const now = tickingNow || initialNow;

  const [meta, setMeta] = useState<OfflineSyncMeta | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [disabledOnPc, setDisabledOnPc] = useState(false);
  const [clearing, setClearing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const autoTriedRef = useRef(false);

  const refreshLocalState = useCallback(async () => {
    const [storedMeta, usage] = await Promise.all([
      getOfflineDb()
        .getMeta()
        .catch(() => null),
      getStorageUsage(),
    ]);
    setMeta(storedMeta);
    setStorage(usage);
  }, []);

  const startSync = useCallback(
    async (automatic = false) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setSyncing(true);
      setProgress(null);
      if (!automatic) setStatusNote(null);

      try {
        const result = await runOfflineSync({
          signal: controller.signal,
          onProgress: setProgress,
        });
        if (result.status === "done") {
          setDisabledOnPc(false);
          setMeta(result.meta);
          if (!automatic) {
            if (result.total === 0) {
              setStatusNote("Synced · no files match your PC offline settings.");
            } else if (result.filesTotal > 0) {
              const pendingNote =
                result.filesPending > 0
                  ? ` · ${formatCount(result.filesPending)} preparing on PC`
                  : "";
              setStatusNote(
                `Synced ${formatCount(result.filesCached)} of ${formatCount(result.filesTotal)} offline copies (${formatBytes(result.filesBytes)})${pendingNote}.`,
              );
            } else {
              setStatusNote(
                `Synced ${formatCount(result.cached)} of ${formatCount(result.total)} thumbnails.`,
              );
            }
          }
        } else if (result.status === "disabled") {
          setDisabledOnPc(true);
          if (!automatic) {
            setStatusNote("Offline browsing is turned off in PC Settings → Offline on phone.");
          }
        } else if (result.status === "revoked") {
          setMeta(null);
          setStatusNote("This phone was removed from grabberX. Offline data was cleared.");
        } else if (result.status === "paused") {
          setStatusNote(
            result.reason === "battery"
              ? "Paused while your PC is on battery. Plug it in, then tap Sync to resume."
              : "Paused while a download runs on the PC. Tap Sync to resume.",
          );
        } else if (result.status === "aborted") {
          setStatusNote("Sync paused. Tap Sync for offline to resume.");
        } else if (result.status === "error" && !automatic) {
          setStatusNote(result.message);
        }
      } finally {
        abortRef.current = null;
        setSyncing(false);
        setProgress(null);
        await refreshLocalState();
      }
    },
    [refreshLocalState],
  );

  useEffect(() => {
    void refreshLocalState();
  }, [refreshLocalState]);

  useEffect(() => {
    if (autoTriedRef.current) return;
    autoTriedRef.current = true;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if (!shouldAutoSync()) return;
    void startSync(true);
  }, [startSync]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleClear() {
    if (clearing || syncing) return;
    setClearing(true);
    try {
      await wipeOfflineStorage();
      setMeta(null);
      setStatusNote("Offline data cleared from this phone.");
      await refreshLocalState();
    } finally {
      setClearing(false);
    }
  }

  const hasOfflineData = Boolean(meta && meta.lastSyncedAt > 0 && meta.enabled);
  const syncedAgo =
    hasOfflineData && meta ? formatRelative(new Date(meta.lastSyncedAt).toISOString(), new Date(now)) : null;

  const showThumbBar = progress?.phase === "thumbs" && progress.total > 0;
  const showFileBar = progress?.phase === "files" && progress.filesTotal > 0;
  const pct = showThumbBar
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : showFileBar
      ? Math.min(100, Math.round((progress.filesDone / progress.filesTotal) * 100))
      : 0;

  const fileTotal = meta?.fileTotal ?? 0;
  const fileCount = meta?.fileCount ?? 0;
  const fileBytes = meta?.fileBytes ?? 0;
  const filePending = meta?.filePending ?? 0;

  return (
    <section
      aria-label="Offline gallery"
      className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-label font-semibold text-ink">Offline gallery</h2>
          {hasOfflineData && meta ? (
            <>
              <span className="text-small text-ink-2 tabular-nums">
                {formatCount(meta.thumbCount)} of {formatCount(meta.totalFiles)} thumbnails
                {syncedAgo ? ` · synced ${syncedAgo}` : ""}
              </span>
              {fileTotal > 0 ? (
                <span className="text-small text-ink-2 tabular-nums">
                  Offline copies: {formatCount(fileCount)} of {formatCount(fileTotal)} · {formatBytes(fileBytes)}
                  {filePending > 0 ? ` · ${formatCount(filePending)} preparing` : ""}
                </span>
              ) : null}
            </>
          ) : disabledOnPc ? (
            <span className="text-small text-ink-2">Turned off in PC Settings → Offline on phone.</span>
          ) : (
            <span className="text-small text-ink-2">Save thumbnails and offline copies to browse while the PC is off.</span>
          )}
        </div>
        {hasOfflineData ? (
          <Link
            href="/m/offline"
            className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-surface px-3 text-small font-medium text-ink transition-colors duration-120 hover:border-ink-2"
          >
            Offline view
          </Link>
        ) : null}
      </div>

      {syncing && progress ? (
        <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-small text-ink-2 tabular-nums">
            <span>
              {progress.phase === "index"
                ? "Checking library index…"
                : progress.phase === "pruning"
                  ? "Updating cache…"
                  : progress.phase === "files"
                    ? `Syncing offline copies… ${formatCount(progress.filesCached)} / ${formatCount(progress.filesTotal)} · ${formatBytes(progress.filesBytes)}`
                    : `Syncing thumbnails… ${formatCount(progress.done)} / ${formatCount(progress.total)}`}
            </span>
            {showThumbBar || showFileBar ? <span>{pct}%</span> : null}
          </div>
          {showThumbBar || showFileBar ? (
            <div
              role="progressbar"
              aria-label="Offline sync progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-1.5 w-full overflow-hidden rounded-sm bg-sunken"
            >
              <div className="h-full bg-ink transition-[width] duration-120" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      {statusNote ? (
        <p className="m-0 text-small text-ink-2" role="status" aria-live="polite">
          {statusNote}
        </p>
      ) : null}

      {storage && (hasOfflineData || storage.usage > 0) ? (
        <p className="m-0 text-small text-ink-2 tabular-nums">
          Storage: {formatBytes(storage.usage)}
          {storage.quota > 0 ? ` of ${formatBytes(storage.quota)}` : ""}
          {storage.persisted ? " · persistent" : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {syncing ? (
          <Button
            variant="secondary"
            className="min-h-11"
            onClick={() => abortRef.current?.abort()}
          >
            Stop sync
          </Button>
        ) : (
          <Button
            variant="secondary"
            className="min-h-11"
            onClick={() => void startSync(false)}
          >
            Sync for offline
          </Button>
        )}
        {hasOfflineData ? (
          <Button
            variant="ghost"
            className="min-h-11 text-ink-2"
            disabled={syncing}
            loading={clearing}
            onClick={() => void handleClear()}
          >
            Clear offline data
          </Button>
        ) : null}
      </div>
    </section>
  );
}
