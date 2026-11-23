"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, postInfoOf } from "@/components/gallery/format";
import type { KindFilter, SortKey } from "@/components/gallery/format";
import { Toolbar, ToolbarButton } from "@/components/gallery/toolbar";
import {
  BackIcon,
  CrossIcon,
  DownloadIcon,
  ExternalIcon,
  FolderIcon,
  InfoIcon,
  PlayIcon,
  ReloadIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useNow } from "@/components/use-now";
import { cn } from "@/lib/cn";
import { formatBytes, formatCount, formatRelative } from "@/lib/format";
import {
  OFFLINE_FILES_CACHE,
  OFFLINE_THUMBS_CACHE,
  offlineFileUrl,
  offlineThumbUrl,
} from "@/lib/offline";
import type { OfflineIndexAccount, OfflineIndexFile } from "@/lib/offline";
import { getOfflineDb } from "@/lib/offline-db";
import type { OfflineSyncMeta } from "@/lib/offline-db";

const GRID_GAP = 4;
const OVERSCAN_ROWS = 4;

function sortOfflineFiles(files: readonly OfflineIndexFile[], sort: SortKey): OfflineIndexFile[] {
  const copy = [...files];
  if (sort === "newest") {
    copy.sort((a, b) => b.filename.localeCompare(a.filename, undefined, { numeric: true }));
  } else if (sort === "oldest") {
    copy.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  } else {
    copy.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  }
  return copy;
}

function safeFromPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/m") || raw.startsWith("//")) return "/m";
  return raw;
}

/** Loads a cached blob as a managed Object URL, revoking it on change or unmount. */
function useCachedBlob(cacheName: string, url: string | null): { objectUrl: string | null; missing: boolean } {
  const [state, setState] = useState<{ objectUrl: string | null; missing: boolean }>({
    objectUrl: null,
    missing: false,
  });

  useEffect(() => {
    if (!url || typeof caches === "undefined") {
      setState({ objectUrl: null, missing: true });
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;

    void caches
      .open(cacheName)
      .then((cache) => cache.match(url))
      .then((res) => (res && res.ok ? res.blob() : null))
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          setState({ objectUrl: null, missing: true });
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setState({ objectUrl: createdUrl, missing: false });
      })
      .catch(() => {
        if (!cancelled) setState({ objectUrl: null, missing: true });
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [cacheName, url]);

  return state;
}

function OfflineTile({
  file,
  index,
  onOpen,
}: {
  file: OfflineIndexFile;
  index: number;
  onOpen: (index: number) => void;
}) {
  const thumbUrl = offlineThumbUrl(file.account, file.folder, file.filename, file.v);
  const { objectUrl, missing } = useCachedBlob(OFFLINE_THUMBS_CACHE, thumbUrl);

  return (
    <button
      type="button"
      data-index={index}
      data-name={file.filename}
      aria-label={file.filename}
      onClick={() => onOpen(index)}
      className="group relative aspect-square min-h-11 select-none overflow-hidden rounded-sm border border-line bg-sunken p-0 transition-colors duration-120 hover:border-ink-2"
    >
      {objectUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- local blob URL from Cache Storage
        <img
          src={objectUrl}
          alt=""
          decoding="async"
          draggable={false}
          className="size-full object-cover"
        />
      ) : missing ? (
        <span className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-ink-2">
          {file.kind === "video" ? <PlayIcon className="size-6" /> : null}
          <span className="max-w-full truncate font-mono text-[11px]">{file.filename}</span>
        </span>
      ) : null}
      {file.kind === "video" ? (
        <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded-sm bg-stage/80 px-1.5 py-0.5 text-small text-on-stage tabular-nums">
          <PlayIcon className="size-3" />
          {file.duration !== undefined ? formatDuration(file.duration) : null}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Lightbox for the offline gallery.
 * Checks Layer 3 (`gather-m-offline-files-v1`) first for a full-size/playable offline copy;
 * otherwise displays the Layer 2 320 px thumbnail from `gather-m-offline-thumbs-v1`.
 */
function OfflineLightbox({
  files,
  index,
  onIndex,
  onClose,
}: {
  files: OfflineIndexFile[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const file = files[index];
  const [info, setInfo] = useState(false);
  const [source, setSource] = useState<{ url: string | null; isFullCopy: boolean; loading: boolean }>({
    url: null,
    isFullCopy: false,
    loading: true,
  });
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    if (!file || typeof caches === "undefined") {
      setSource({ url: null, isFullCopy: false, loading: false });
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setSource({ url: null, isFullCopy: false, loading: true });

    const fullKey = offlineFileUrl(file.account, file.folder, file.filename, file.v);
    const thumbKey = offlineThumbUrl(file.account, file.folder, file.filename, file.v);

    void (async () => {
      try {
        // Layer 3: prefer reduced-quality full-size / transcoded copy when cached.
        const fullCache = await caches.open(OFFLINE_FILES_CACHE);
        const fullRes = await fullCache.match(fullKey);
        if (!cancelled && fullRes && fullRes.ok) {
          const rawBlob = await fullRes.blob();
          const blob =
            file.kind === "video" && !rawBlob.type
              ? new Blob([rawBlob], { type: "video/mp4" })
              : rawBlob;
          if (!cancelled) {
            createdUrl = URL.createObjectURL(blob);
            setSource({ url: createdUrl, isFullCopy: true, loading: false });
            return;
          }
        }
      } catch {
        // Fall through to thumbnail cache.
      }

      try {
        const thumbCache = await caches.open(OFFLINE_THUMBS_CACHE);
        const thumbRes = await thumbCache.match(thumbKey);
        if (!cancelled && thumbRes && thumbRes.ok) {
          const blob = await thumbRes.blob();
          if (!cancelled) {
            createdUrl = URL.createObjectURL(blob);
            setSource({ url: createdUrl, isFullCopy: false, loading: false });
            return;
          }
        }
      } catch {
        // ignore
      }

      if (!cancelled) {
        setSource({ url: null, isFullCopy: false, loading: false });
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [file]);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < files.length) onIndex(next);
    },
    [files.length, index, onIndex],
  );

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [go, onClose]);

  if (!file) return null;
  const post = postInfoOf(file.filename, "x");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${file.filename}, ${index + 1} of ${files.length}`}
      className="fixed inset-0 z-50 flex flex-col bg-stage text-on-stage outline-none [--focus:var(--color-on-stage)]"
    >
      <div className="flex items-center justify-between px-2 pt-[env(safe-area-inset-top)]">
        <span className="px-2 text-small tabular-nums" aria-live="polite">
          {index + 1} / {files.length}
        </span>
        <Toolbar label="Offline viewer actions">
          <ToolbarButton label="Details" pressed={info} onClick={() => setInfo((value) => !value)}>
            <InfoIcon />
          </ToolbarButton>
          <ToolbarButton
            label="View original (needs PC)"
            disabled
            title="Connect to your PC to view the original file"
            onClick={() => {}}
          >
            <ExternalIcon />
          </ToolbarButton>
          <ToolbarButton
            label="Download (needs PC)"
            disabled
            title="Connect to your PC to download the original file"
            onClick={() => {}}
          >
            <DownloadIcon />
          </ToolbarButton>
          <ToolbarButton label="Close" onClick={onClose}>
            <CrossIcon />
          </ToolbarButton>
        </Toolbar>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4"
        onTouchStart={(event) => {
          touchStartX.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          const start = touchStartX.current;
          touchStartX.current = null;
          const end = event.changedTouches[0]?.clientX;
          if (start === null || end === undefined) return;
          const dx = end - start;
          if (dx < -48) go(1);
          else if (dx > 48) go(-1);
        }}
      >
        {source.url ? (
          file.kind === "video" && source.isFullCopy ? (
            <video src={source.url} controls playsInline className="max-h-full max-w-full">
              <track kind="captions" />
            </video>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- local blob URL from Cache Storage
            <img
              src={source.url}
              alt={file.filename}
              className="max-h-full max-w-full object-contain"
            />
          )
        ) : !source.loading ? (
          <div className="flex flex-col items-center gap-2 text-center text-on-stage/80">
            {file.kind === "video" ? <PlayIcon className="size-10" /> : null}
            <span className="font-mono text-small">{file.filename}</span>
            <span className="text-small text-on-stage/60">
              {file.kind === "video"
                ? "No offline video thumbnail cached."
                : "No offline preview cached."}
            </span>
          </div>
        ) : null}

        {index > 0 ? (
          <button
            type="button"
            aria-label="Previous"
            onClick={() => go(-1)}
            className="absolute left-2 flex size-11 items-center justify-center rounded-md border border-on-stage/20 bg-stage/70 text-on-stage"
          >
            <BackIcon className="size-5" />
          </button>
        ) : null}
        {index < files.length - 1 ? (
          <button
            type="button"
            aria-label="Next"
            onClick={() => go(1)}
            className="absolute right-2 flex size-11 items-center justify-center rounded-md border border-on-stage/20 bg-stage/70 text-on-stage"
          >
            <BackIcon className="size-5 rotate-180" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-on-stage/15 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {!source.isFullCopy ? (
          <span className="text-small text-on-stage/70">
            {file.kind === "video"
              ? "Video preview · connect to your PC to play the full video."
              : "Thumbnail preview · connect to your PC for the full original."}
          </span>
        ) : (
          <span className="text-small text-on-stage/70">Saved offline copy</span>
        )}
        {info ? (
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
            <dt className="text-on-stage/60">File</dt>
            <dd className="m-0 truncate font-mono">{file.filename}</dd>
            <dt className="text-on-stage/60">Folder</dt>
            <dd className="m-0 font-mono">{file.folder || "(root)"}</dd>
            <dt className="text-on-stage/60">Size</dt>
            <dd className="m-0 tabular-nums">{formatBytes(file.size)}</dd>
            {file.width && file.height ? (
              <>
                <dt className="text-on-stage/60">Dimensions</dt>
                <dd className="m-0 tabular-nums">
                  {file.width} × {file.height}
                </dd>
              </>
            ) : null}
            {file.duration !== undefined ? (
              <>
                <dt className="text-on-stage/60">Duration</dt>
                <dd className="m-0 tabular-nums">{formatDuration(file.duration)}</dd>
              </>
            ) : null}
            {post?.date ? (
              <>
                <dt className="text-on-stage/60">Posted</dt>
                <dd className="m-0">{post.date.toLocaleDateString()}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

/** Virtualized square-tile grid that only renders rows near the viewport. */
function VirtualizedOfflineGrid({
  files,
  onOpen,
}: {
  files: OfflineIndexFile[];
  onOpen: (index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ width: 360, scrollY: 0, viewportH: 800, topOffset: 0 });

  useEffect(() => {
    function measure() {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setMetrics({
        width: Math.max(240, rect.width),
        scrollY: window.scrollY,
        viewportH: window.innerHeight,
        topOffset: rect.top + window.scrollY,
      });
    }
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  const columns = metrics.width >= 560 ? 4 : 3;
  const tileSize = Math.max(64, Math.floor((metrics.width - GRID_GAP * (columns - 1)) / columns));
  const rowHeight = tileSize + GRID_GAP;
  const totalRows = Math.ceil(files.length / columns);
  const totalHeight = Math.max(0, totalRows * rowHeight - (totalRows > 0 ? GRID_GAP : 0));

  const relativeScroll = Math.max(0, metrics.scrollY - metrics.topOffset);
  const startRow = Math.max(0, Math.floor(relativeScroll / rowHeight) - OVERSCAN_ROWS);
  const visibleRowCount = Math.ceil(metrics.viewportH / rowHeight) + OVERSCAN_ROWS * 2;
  const endRow = Math.min(totalRows, startRow + visibleRowCount);

  const startIndex = startRow * columns;
  const endIndex = Math.min(files.length, endRow * columns);
  const slice = files.slice(startIndex, endIndex);

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: totalHeight }}>
      <div
        className="grid"
        style={{
          transform: `translate3d(0, ${startRow * rowHeight}px, 0)`,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: `${GRID_GAP}px`,
        }}
      >
        {slice.map((file, offset) => (
          <OfflineTile key={file.id} file={file} index={startIndex + offset} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

export function OfflineGallery() {
  const now = useNow(true, 30_000);
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<OfflineSyncMeta | null>(null);
  const [accounts, setAccounts] = useState<OfflineIndexAccount[]>([]);
  const [allAccountFiles, setAllAccountFiles] = useState<OfflineIndexFile[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState("");
  const [filter, setFilter] = useState<KindFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [online, setOnline] = useState(true);
  const [pcUnreachable, setPcUnreachable] = useState(false);
  const [fromPath, setFromPath] = useState("/m");

  useEffect(() => {
    setOnline(window.navigator.onLine);
    const params = new URLSearchParams(window.location.search);
    setFromPath(safeFromPath(params.get("from")));
    setPcUnreachable(params.get("offline") === "1");

    function onOnline() {
      setOnline(true);
    }
    function onOffline() {
      setOnline(false);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = getOfflineDb();
        const [storedMeta, storedAccounts] = await Promise.all([db.getMeta(), db.listAccounts()]);
        if (cancelled) return;
        setMeta(storedMeta);
        setAccounts(storedAccounts);
      } catch {
        if (!cancelled) {
          setMeta(null);
          setAccounts([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedAccount) {
      setAllAccountFiles([]);
      return;
    }
    let cancelled = false;
    void getOfflineDb()
      .listFiles(selectedAccount)
      .then((rows) => {
        if (!cancelled) setAllAccountFiles(rows);
      })
      .catch(() => {
        if (!cancelled) setAllAccountFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccount]);

  const subfolders = useMemo(() => {
    const names = new Set<string>();
    const prefix = currentFolder ? `${currentFolder}/` : "";
    for (const file of allAccountFiles) {
      if (!file.folder) continue;
      if (prefix && !file.folder.startsWith(prefix)) continue;
      const rest = prefix ? file.folder.slice(prefix.length) : file.folder;
      if (!rest) continue;
      const nextSegment = rest.split("/", 1)[0];
      if (nextSegment) names.add(nextSegment);
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [allAccountFiles, currentFolder]);

  const visibleFiles = useMemo(() => {
    const prefix = currentFolder ? `${currentFolder}/` : "";
    const inScope = allAccountFiles.filter((file) => {
      if (currentFolder && file.folder !== currentFolder && !file.folder.startsWith(prefix)) {
        return false;
      }
      if (filter === "image") return file.kind === "image";
      if (filter === "video") return file.kind === "video";
      return true;
    });
    return sortOfflineFiles(inScope, sort);
  }, [allAccountFiles, currentFolder, filter, sort]);

  function reconnect() {
    window.location.assign(fromPath || "/m");
  }

  if (loading) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-10">
        <p className="m-0 text-body text-ink-2">Loading offline library…</p>
      </main>
    );
  }

  const isOfflineMode = !online || pcUnreachable;
  const hasSyncedData = Boolean(meta && meta.enabled && accounts.length > 0);
  if (!hasSyncedData) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-3 px-6 py-8">
        <h1 className="m-0 text-title">{isOfflineMode ? "Can\u2019t reach your PC" : "Offline library"}</h1>
        <p className="m-0 text-body text-ink-2">
          {isOfflineMode
            ? "Check that grabberX is open on your PC with Mobile gallery turned on, and that this phone is on the same network."
            : "Nothing is synced on this phone yet. Turn on Offline on phone in PC Settings, then tap Sync for offline on the Library page."}
        </p>
        <div className="pt-1">
          <Button variant="primary" className="min-h-11" onClick={reconnect}>
            {isOfflineMode ? "Try again" : "Back to library"}
          </Button>
        </div>
      </main>
    );
  }

  const syncedAgo =
    now > 0 && meta ? formatRelative(new Date(meta.lastSyncedAt).toISOString(), new Date(now)) : "";
  const statusLabel = `${isOfflineMode ? "Offline" : "Offline copy"} · last synced ${syncedAgo || "recently"}`;
  const folderSegments = currentFolder ? currentFolder.split("/") : [];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-16 sm:px-6">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-strong bg-sunken px-3 py-2 text-small text-ink-2"
      >
        <span>{statusLabel}</span>
        <button
          type="button"
          onClick={reconnect}
          className="inline-flex min-h-11 items-center gap-1.5 text-small font-medium text-ink underline decoration-line-strong underline-offset-4"
        >
          <ReloadIcon className="size-3.5" />
          {isOfflineMode ? "Try again" : "Live library"}
        </button>
      </div>

      {selectedAccount === null ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <h1 className="m-0 text-display">Library</h1>
            <Button
              variant="secondary"
              disabled
              title="Connect to your PC to start downloads"
              className="min-h-11"
            >
              <DownloadIcon className="size-4" />
              Download
            </Button>
          </div>
          <p className="m-0 text-small text-ink-2 tabular-nums">
            {(meta?.fileCount ?? 0) > 0
              ? `Browsing offline (${formatCount(meta?.fileCount ?? 0)} offline copies · ${formatBytes(meta?.fileBytes ?? 0)}). Downloads and originals need your PC.`
              : `Browsing cached thumbnails (${formatCount(meta?.thumbCount ?? 0)} saved). Downloads and original files need your PC.`}
          </p>
          <ul className="m-0 flex list-none flex-col divide-y divide-line border-y border-line p-0">
            {accounts.map((account) => (
              <li key={account.folder}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedAccount(account.folder);
                    setCurrentFolder("");
                    setFilter("all");
                    setViewerIndex(null);
                  }}
                  className="flex min-h-14 w-full items-center justify-between gap-3 bg-transparent py-2.5 text-left"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-mono text-body text-ink">{account.folder}</span>
                    <span className="text-small text-ink-2 tabular-nums">
                      {formatCount(account.imageCount)} images · {formatCount(account.videoCount)} videos ·{" "}
                      {formatBytes(account.totalBytes)}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-ink-2">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-small text-ink-2">
            <button
              type="button"
              onClick={() => {
                setSelectedAccount(null);
                setCurrentFolder("");
                setViewerIndex(null);
              }}
              className="inline-flex min-h-11 items-center px-1 underline decoration-line-strong underline-offset-4 hover:text-ink"
            >
              Library
            </button>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              onClick={() => {
                setCurrentFolder("");
                setViewerIndex(null);
              }}
              className={cn(
                "inline-flex min-h-11 items-center px-1 font-mono",
                folderSegments.length === 0 ? "text-ink" : "underline decoration-line-strong underline-offset-4 hover:text-ink",
              )}
            >
              {selectedAccount}
            </button>
            {folderSegments.map((seg, idx) => {
              const target = folderSegments.slice(0, idx + 1).join("/");
              const isLast = idx === folderSegments.length - 1;
              return (
                <span key={target} className="inline-flex items-center gap-1">
                  <span aria-hidden="true">/</span>
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentFolder(target);
                      setViewerIndex(null);
                    }}
                    className={cn(
                      "inline-flex min-h-11 items-center px-1 font-mono",
                      isLast ? "text-ink" : "underline decoration-line-strong underline-offset-4 hover:text-ink",
                    )}
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
          </nav>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="m-0 font-mono text-display font-normal">
              {folderSegments.at(-1) ?? selectedAccount}
            </h1>
            <Button
              variant="secondary"
              size="sm"
              disabled
              title="Connect to your PC to download a zip"
              className="min-h-11"
            >
              <DownloadIcon className="size-3.5" />
              Download zip
            </Button>
          </div>

          {subfolders.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {subfolders.map((name) => {
                const nextFolder = currentFolder ? `${currentFolder}/${name}` : name;
                return (
                  <button
                    key={nextFolder}
                    type="button"
                    onClick={() => {
                      setCurrentFolder(nextFolder);
                      setViewerIndex(null);
                    }}
                    className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 font-mono text-label text-ink transition-colors duration-120 hover:border-ink-2"
                  >
                    <FolderIcon className="size-4 text-ink-2" />
                    {name}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              label="Show"
              size="sm"
              value={filter}
              onChange={(value) => {
                setFilter(value as KindFilter);
                setViewerIndex(null);
              }}
              options={[
                { value: "all", label: "All" },
                { value: "image", label: "Images" },
                { value: "video", label: "Videos" },
              ]}
            />
            <Segmented
              label="Sort"
              size="sm"
              value={sort}
              onChange={(value) => {
                setSort(value as SortKey);
                setViewerIndex(null);
              }}
              options={[
                { value: "newest", label: "Newest" },
                { value: "oldest", label: "Oldest" },
                { value: "name", label: "Name" },
              ]}
            />
          </div>

          {visibleFiles.length === 0 ? (
            <p className="m-0 text-body text-ink-2">Nothing matches this filter in this folder.</p>
          ) : (
            <VirtualizedOfflineGrid files={visibleFiles} onOpen={(idx) => setViewerIndex(idx)} />
          )}

          {viewerIndex !== null ? (
            <OfflineLightbox
              files={visibleFiles}
              index={viewerIndex}
              onIndex={setViewerIndex}
              onClose={() => setViewerIndex(null)}
            />
          ) : null}
        </>
      )}
    </main>
  );
}
