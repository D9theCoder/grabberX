"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { postDateOf, postIdOf, postUrlOf, sortFiles } from "@/components/gallery/format";
import type { KindFilter, SortKey } from "@/components/gallery/format";
import type { MediaFile } from "@/components/gallery/types";

const CHUNK = 90;
const SWIPE_PX = 50;
const LONG_PRESS_MS = 450;

function versionOf(file: Pick<MediaFile, "size" | "mtimeMs">): string {
  return `${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}`;
}

function mediaUrl(account: string, path: string, file: MediaFile, options: { thumb?: 240 | 480; download?: boolean } = {}): string {
  const relative = path === "" ? file.name : `${path}/${file.name}`;
  const params = new URLSearchParams({ account, path: relative });
  if (options.thumb) params.set("thumb", String(options.thumb));
  if (options.download) params.set("download", "1");
  params.set("v", versionOf(file));
  return `/api/media?${params.toString()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** One file downloads as itself; several come back as one zip, as on the desktop. The server writes nothing. */
function startDownload(account: string, path: string, files: MediaFile[]): void {
  if (files.length === 0) return;
  if (files.length === 1) {
    const link = document.createElement("a");
    link.href = mediaUrl(account, path, files[0]!, { download: true });
    link.download = files[0]!.name;
    document.body.append(link);
    link.click();
    link.remove();
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/media/zip";
  form.hidden = true;
  const add = (name: string, value: string) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  };
  add("account", account);
  add("path", path);
  for (const file of files) add("name", file.name);
  document.body.append(form);
  form.submit();
  form.remove();
}

/** A video with no saved poster yet shows its first frame directly; the phone never posts one back. */
function VideoPreview({ source, className = "" }: { source: string; className?: string }) {
  return (
    <video
      src={`${source}#t=0.1`}
      preload="metadata"
      muted
      playsInline
      tabIndex={-1}
      aria-hidden="true"
      // The fragment seeks on browsers that honor it; setting the time once covers the ones that ignore it.
      onLoadedMetadata={(event) => {
        if (event.currentTarget.currentTime === 0) event.currentTarget.currentTime = 0.1;
      }}
      className={`pointer-events-none size-full object-cover ${className}`}
    />
  );
}

function Tile({
  file,
  account,
  path,
  selecting,
  selected,
  onPress,
  onLongPress,
}: {
  file: MediaFile;
  account: string;
  path: string;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const [posterMissing, setPosterMissing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <button
      type="button"
      onPointerDown={() => {
        longPressed.current = false;
        cancel();
        timer.current = setTimeout(() => {
          longPressed.current = true;
          onLongPress();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onClick={() => {
        // The click that ends a long press must not also toggle the tile it just selected.
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onPress();
      }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={`${selecting ? (selected ? "Deselect" : "Select") : "Open"} ${file.name}`}
      aria-pressed={selecting ? selected : undefined}
      className="relative aspect-square touch-pan-y overflow-hidden bg-sunken p-0 select-none [-webkit-touch-callout:none]"
    >
      {file.kind === "video" && posterMissing ? (
        // No poster has been captured yet. Load the metadata and show the first frame instead of a blank tile.
        <VideoPreview source={mediaUrl(account, path, file)} className={selected ? "scale-90" : ""} />
      ) : broken ? null : (
        // 480 is the size the warmer pre-builds; asking for 240 would decode every thumbnail on demand.
        // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from the media route with their own cache headers
        <img
          src={mediaUrl(account, path, file, { thumb: 480 })}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => {
            if (file.kind === "video") setPosterMissing(true);
            else setBroken(true);
          }}
          className={`size-full object-cover ${selected ? "scale-90" : ""}`}
        />
      )}
      {file.kind === "video" ? (
        <span aria-hidden className="absolute right-1.5 bottom-1.5 flex size-7 items-center justify-center rounded-full bg-black/60 text-xs text-white">
          ▶
        </span>
      ) : null}
      {selecting ? (
        <span
          aria-hidden
          className={`absolute top-1.5 left-1.5 flex size-6 items-center justify-center rounded-full border-2 text-sm ${
            selected ? "border-white bg-blue-600 text-white" : "border-white bg-black/30 text-transparent"
          }`}
        >
          ✓
        </span>
      ) : null}
    </button>
  );
}

function Viewer({
  files,
  index,
  account,
  path,
  onIndex,
  onClose,
}: {
  files: MediaFile[];
  index: number;
  account: string;
  path: string;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const file = files[index];
  const start = useRef<{ x: number; y: number } | null>(null);
  const [info, setInfo] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < files.length) {
        setSize(null);
        onIndex(next);
      }
    },
    [index, files.length, onIndex],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  function down(event: ReactPointerEvent) {
    start.current = { x: event.clientX, y: event.clientY };
  }
  function up(event: ReactPointerEvent) {
    const from = start.current;
    start.current = null;
    if (!from) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }

  if (!file) return null;
  const src = mediaUrl(account, path, file);
  const postId = postIdOf(file.name);
  const posted = postId ? postDateOf(postId) : null;

  return (
    <div role="dialog" aria-modal="true" aria-label={file.name} className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={onClose} aria-label="Close" className="flex size-12 items-center justify-center text-2xl">
          ✕
        </button>
        <span className="text-small tabular-nums">
          {index + 1} / {files.length}
        </span>
        <div className="flex">
          <button
            type="button"
            onClick={() => setInfo((value) => !value)}
            aria-label="Details"
            aria-pressed={info}
            className="flex size-12 items-center justify-center text-xl"
          >
            ⓘ
          </button>
          <button
            type="button"
            onClick={() => startDownload(account, path, [file])}
            aria-label="Download"
            className="flex size-12 items-center justify-center text-xl"
          >
            ⬇
          </button>
        </div>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onPointerDown={down}
        onPointerUp={up}
        style={{ touchAction: "pan-y pinch-zoom" }}
      >
        {file.kind === "video" ? (
          <video
            key={src}
            src={src}
            controls
            autoPlay
            playsInline
            onLoadedMetadata={(event) => setSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
            className="max-h-full max-w-full"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- the original file, streamed by the media route
          <img
            key={src}
            src={src}
            alt={file.name}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
      {info ? (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 bg-black/80 px-4 py-3 text-small">
          <dt className="text-white/60">Name</dt>
          <dd className="m-0 font-mono break-all">{file.name}</dd>
          <dt className="text-white/60">Size</dt>
          <dd className="m-0">{formatBytes(file.size)}</dd>
          {size ? (
            <>
              <dt className="text-white/60">Dimensions</dt>
              <dd className="m-0">
                {size.width} × {size.height}
              </dd>
            </>
          ) : null}
          <dt className="text-white/60">{posted ? "Posted" : "Modified"}</dt>
          <dd className="m-0">{(posted ?? new Date(file.mtimeMs)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</dd>
          {postId ? (
            <>
              <dt className="text-white/60">Post</dt>
              <dd className="m-0">
                <a href={postUrlOf(postId)} target="_blank" rel="noopener noreferrer" className="underline">
                  Open on X
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="flex justify-between px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button type="button" disabled={index === 0} onClick={() => go(-1)} aria-label="Previous" className="size-12 text-3xl disabled:opacity-30">
          ‹
        </button>
        <button
          type="button"
          disabled={index === files.length - 1}
          onClick={() => go(1)}
          aria-label="Next"
          className="size-12 text-3xl disabled:opacity-30"
        >
          ›
        </button>
      </div>
    </div>
  );
}

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name" },
];
const KINDS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
];

/**
 * Grid for a phone: folders, thumbnails, a swipe viewer, multi-select and downloads. It reads and downloads;
 * no action here changes a file, and the gateway would refuse one anyway.
 */
export function MobileGallery({
  account,
  path,
  base,
  folders,
  files,
  maxZipFiles,
  maxZipBytes,
}: {
  account: string;
  path: string;
  base: string;
  folders: string[];
  files: MediaFile[];
  maxZipFiles: number;
  maxZipBytes: number;
}) {
  const [sort, setSort] = useState<SortKey>("newest");
  const [kind, setKind] = useState<KindFilter>("all");
  const shown = useMemo(() => sortFiles(files.filter((file) => kind === "all" || file.kind === kind), sort), [files, kind, sort]);
  const [visible, setVisible] = useState(CHUNK);
  const [open, setOpen] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sentinel = useRef<HTMLDivElement>(null);
  const pushed = useRef(false);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible((count) => count + CHUNK);
      },
      { rootMargin: "800px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // Observe again after each chunk: a sentinel that is still on screen would not fire a second time.
  }, [visible]);

  // The Android back gesture closes the viewer instead of leaving the folder.
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
      setOpen(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openAt = (index: number) => {
    if (!pushed.current) {
      window.history.pushState({ viewer: true }, "");
      pushed.current = true;
    }
    setOpen(index);
  };
  const close = useCallback(() => {
    if (pushed.current) window.history.back();
    else setOpen(null);
  }, []);

  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const chosen = useMemo(() => files.filter((file) => selected.has(file.name)), [files, selected]);
  const chosenBytes = chosen.reduce((sum, file) => sum + file.size, 0);
  const overCount = chosen.length > maxZipFiles;
  const overBytes = chosenBytes > maxZipBytes;
  const problem = overCount
    ? `Choose ${maxZipFiles} files or fewer for one zip.`
    : overBytes
      ? "Those files are over 4 GB together. Choose fewer."
      : "";

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3">
        <label className="flex items-center gap-1.5 text-small text-ink-2">
          Sort
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="min-h-9 rounded-md border border-line-strong bg-surface px-2 text-ink"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-small text-ink-2">
          Show
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as KindFilter);
              setVisible(CHUNK);
            }}
            className="min-h-9 rounded-md border border-line-strong bg-surface px-2 text-ink"
          >
            {KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {files.length > 0 ? (
          <button
            type="button"
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            aria-pressed={selecting}
            className="ml-auto min-h-9 rounded-md border border-line-strong px-3 text-small text-ink"
          >
            {selecting ? "Done" : "Select"}
          </button>
        ) : null}
      </div>

      {folders.length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-line border-y border-line p-0">
          {folders.map((name) => (
            <li key={name}>
              <Link href={`${base}/${encodeURIComponent(name)}`} className="flex min-h-12 items-center justify-between gap-3 px-4 font-mono text-body">
                <span className="min-w-0 truncate">{name}</span>
                <span aria-hidden className="text-ink-2">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {files.length === 0 && folders.length === 0 ? <p className="m-0 px-4 text-body text-ink-2">This folder is empty.</p> : null}
      {files.length > 0 && shown.length === 0 ? <p className="m-0 px-4 text-body text-ink-2">Nothing matches this filter in this folder.</p> : null}

      {shown.length > 0 ? (
        <div className={`grid grid-cols-3 gap-0.5 sm:grid-cols-4 ${selecting ? "pb-24" : ""}`}>
          {shown.slice(0, visible).map((file, index) => (
            <Tile
              key={file.name}
              file={file}
              account={account}
              path={path}
              selecting={selecting}
              selected={selected.has(file.name)}
              onPress={() => (selecting ? toggle(file.name) : openAt(index))}
              onLongPress={() => {
                setSelecting(true);
                setSelected((current) => new Set(current).add(file.name));
              }}
            />
          ))}
        </div>
      ) : null}
      {visible < shown.length ? <div ref={sentinel} className="h-8" /> : null}

      {selecting ? (
        <div
          role="toolbar"
          aria-label="Selection"
          className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-1 border-t border-line bg-paper px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-small" aria-live="polite">
              {chosen.length === 0 ? "Tap photos to select" : `${chosen.length} selected · ${formatBytes(chosenBytes)}`}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set(shown.map((file) => file.name)))}
                className="min-h-10 rounded-md border border-line-strong px-3 text-small"
              >
                All
              </button>
              <button
                type="button"
                disabled={chosen.length === 0}
                onClick={() => setSelected(new Set())}
                className="min-h-10 rounded-md border border-line-strong px-3 text-small disabled:opacity-40"
              >
                None
              </button>
              <button
                type="button"
                disabled={chosen.length === 0 || problem !== ""}
                onClick={() => startDownload(account, path, chosen)}
                className="min-h-10 rounded-md bg-ink px-3 text-small font-medium text-on-ink disabled:opacity-40"
              >
                Download
              </button>
            </div>
          </div>
          {problem ? (
            <span role="alert" className="text-small text-danger">
              {problem}
            </span>
          ) : null}
        </div>
      ) : null}

      {open !== null ? <Viewer files={shown} index={open} account={account} path={path} onIndex={setOpen} onClose={close} /> : null}
    </>
  );
}
