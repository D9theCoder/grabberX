"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { deleteFile, getFileDetails } from "@/app/library/[account]/actions";
import type { FileDetails } from "@/app/library/[account]/actions";
import { AutoplayIcon, ExpandIcon, LoopIcon, NextIcon, PrevIcon, TrashIcon } from "@/components/gallery/gallery-icons";
import { postDateOf, postIdOf, postUrlOf } from "@/components/gallery/format";
import { mediaUrl } from "@/components/gallery/thumbnail";
import { Toolbar, ToolbarButton } from "@/components/gallery/toolbar";
import type { MediaFile } from "@/components/gallery/types";
import { CopyIcon, CrossIcon, ExternalIcon, FolderIcon, InfoIcon } from "@/components/icons";
import { useContextMenu } from "@/components/context-menu";
import type { MenuEntry } from "@/components/context-menu";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";

export interface LightboxProps {
  account: string;
  /** Folder shown in the grid, relative to the account. Empty at the account root. */
  path: string;
  files: readonly MediaFile[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onDeleted: (name: string) => void;
  /** The gallery's own right-click items for the file on show; the lightbox adds Delete. */
  menuEntries?: (file: MediaFile) => MenuEntry[];
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };
const MAX_SCALE = 16;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(1, scale));
}

/** Zooms around a point given relative to the centre of the stage, so the pixel under the cursor stays put. */
function zoomAt(view: View, nextScale: number, px: number, py: number): View {
  const scale = clampScale(nextScale);
  if (scale === 1) return FIT;
  const ratio = scale / view.scale;
  return { scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

const FOCUSABLE = 'button:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])';

export function Lightbox({ account, path, files, index, onIndexChange, onClose, onDeleted, menuEntries }: LightboxProps) {
  const menu = useContextMenu();
  const file = files[index];
  const relative = file ? (path === "" ? file.name : `${path}/${file.name}`) : "";

  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const opener = useRef<Element | null>(null);

  const [view, setView] = useState<View>(FIT);
  const [showDetails, setShowDetails] = useState(false);
  const [details, setDetails] = useState<FileDetails | null>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [loop, setLoop] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ distance: number; view: View } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    opener.current = document.activeElement;
    dialog.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      const target = opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    setView(FIT);
    setSize(null);
    setDetails(null);
    setConfirming(false);
    setStatus("");
  }, [relative]);

  useEffect(() => {
    if ((!showDetails && !confirming) || relative === "") return;
    let cancelled = false;
    void getFileDetails(account, relative).then((result) => {
      if (!cancelled) setDetails(result);
    });
    return () => {
      cancelled = true;
    };
  }, [account, relative, showDetails, confirming]);

  useEffect(() => {
    for (const neighbour of [files[index + 1], files[index - 1]]) {
      if (neighbour?.kind === "image") new Image().src = mediaUrl(account, path, neighbour.name);
    }
  }, [account, path, files, index]);

  const zoomBy = useCallback((factor: number, px = 0, py = 0) => {
    setView((current) => zoomAt(current, current.scale * factor, px, py));
  }, []);

  useEffect(() => {
    const element = stage.current;
    if (!element || file?.kind !== "image") return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = element!.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      zoomBy(Math.exp(-event.deltaY * 0.0015), px, py);
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [file?.kind, zoomBy, relative]);

  function toggleActualSize(event: { clientX: number; clientY: number }) {
    const element = image.current;
    if (!element) return;
    if (view.scale > 1) {
      setView(FIT);
      return;
    }
    const rect = stage.current!.getBoundingClientRect();
    const actual = element.naturalWidth / Math.max(1, element.clientWidth);
    if (actual <= 1.01) return;
    zoomBy(actual, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (file?.kind !== "image") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), view };
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const rect = stage.current!.getBoundingClientRect();
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const px = (a!.x + b!.x) / 2 - rect.left - rect.width / 2;
      const py = (a!.y + b!.y) / 2 - rect.top - rect.height / 2;
      const start = pinchStart.current;
      setView(zoomAt(start.view, start.view.scale * (distance / Math.max(1, start.distance)), px, py));
      dragged.current = true;
      return;
    }
    if (view.scale > 1) {
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) dragged.current = true;
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void dialog.current?.requestFullscreen?.().catch(() => {});
  }

  function go(step: number) {
    const next = index + step;
    if (next >= 0 && next < files.length) onIndexChange(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === dialog.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirming) setConfirming(false);
      else if (!document.fullscreenElement) onClose();
      return;
    }
    if (confirming) return;
    const target = event.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (typing) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    } else if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      toggleFullscreen();
    } else if (event.key === "i" || event.key === "I") {
      event.preventDefault();
      setShowDetails((open) => !open);
    } else if (event.key === " " && file?.kind === "video" && target.tagName !== "VIDEO" && target.tagName !== "BUTTON") {
      event.preventDefault();
      const element = video.current;
      if (element) void (element.paused ? element.play() : element.pause());
    } else if ((event.key === "+" || event.key === "=") && file?.kind === "image") {
      zoomBy(1.5);
    } else if (event.key === "-" && file?.kind === "image") {
      zoomBy(1 / 1.5);
    } else if (event.key === "0" && file?.kind === "image") {
      setView(FIT);
    }
  }

  async function copyPath() {
    const current = details?.ok ? details : await getFileDetails(account, relative);
    if (!current.ok) {
      setStatus(current.error);
      return;
    }
    try {
      await navigator.clipboard.writeText(current.absolutePath);
      setStatus("Path copied");
    } catch {
      setStatus("The path couldn't be copied.");
    }
  }

  function openInExplorer() {
    void fetch("/api/open-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: account }),
    }).then(
      () => setStatus("Opened the account folder"),
      () => setStatus("The folder couldn't be opened."),
    );
  }

  async function confirmDelete() {
    if (!file) return;
    setBusy(true);
    try {
      const info = await getFileDetails(account, relative);
      if (!info.ok) {
        setStatus(info.error);
        return;
      }
      let trashed = false;
      if (info.recycle) {
        const shell = window.gatherShell;
        if (!shell?.trashItem) {
          setStatus("Moving a file to the Recycle Bin needs the desktop app.");
          return;
        }
        if (!(await shell.trashItem(info.absolutePath))) {
          setStatus("The file couldn't be moved to the Recycle Bin.");
          return;
        }
        trashed = true;
      }
      const result = await deleteFile(account, relative, trashed);
      if (!result.ok) {
        setStatus(result.error);
        return;
      }
      setConfirming(false);
      onDeleted(file.name);
    } finally {
      setBusy(false);
    }
  }

  if (!file) return null;

  const postId = postIdOf(file.name);
  const postDate = postId ? postDateOf(postId) : null;
  const source = mediaUrl(account, path, file.name);
  const recycle = details?.ok ? details.recycle : false;
  const zoomed = view.scale > 1;

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${file.name}, ${index + 1} of ${files.length}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex flex-col bg-stage text-on-stage outline-none [--focus:var(--color-on-stage)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-on-stage/20 px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-label tabular-nums" aria-live="polite">
            {index + 1} of {files.length}
          </span>
          <span className="truncate font-mono text-code text-on-stage/80">{file.name}</span>
        </div>
        <Toolbar label="Viewer actions">
          {file.kind === "video" ? (
            <>
              <ToolbarButton label="Loop" pressed={loop} onClick={() => setLoop((on) => !on)}>
                <LoopIcon />
              </ToolbarButton>
              <ToolbarButton label="Autoplay" pressed={autoplay} onClick={() => setAutoplay((on) => !on)}>
                <AutoplayIcon />
              </ToolbarButton>
            </>
          ) : null}
          <ToolbarButton label="Details (I)" pressed={showDetails} onClick={() => setShowDetails((open) => !open)}>
            <InfoIcon />
          </ToolbarButton>
          <ToolbarButton label="Open in Explorer" onClick={openInExplorer}>
            <FolderIcon />
          </ToolbarButton>
          <ToolbarButton label="Copy path" onClick={() => void copyPath()}>
            <CopyIcon />
          </ToolbarButton>
          <ToolbarButton label="Delete" onClick={() => setConfirming(true)}>
            <TrashIcon />
          </ToolbarButton>
          <ToolbarButton label="Fullscreen (F)" onClick={toggleFullscreen}>
            <ExpandIcon />
          </ToolbarButton>
          <ToolbarButton label="Close (Esc)" onClick={onClose}>
            <CrossIcon />
          </ToolbarButton>
        </Toolbar>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
        <div
          ref={stage}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={file.kind === "image" ? toggleActualSize : undefined}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            menu.open(event, file.name, [
              ...(menuEntries?.(file) ?? []),
              "separator",
              { label: "Delete", icon: <TrashIcon />, shortcut: "Del", danger: true, onSelect: () => setConfirming(true) },
            ]);
          }}
          style={{ touchAction: "none" }}
          className={`relative flex min-w-0 flex-1 items-center justify-center overflow-hidden ${
            file.kind === "image" ? (zoomed ? "cursor-grab" : "cursor-zoom-in") : ""
          }`}
        >
          {file.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- the original file from our own route, shown at full size
            <img
              key={relative}
              ref={image}
              src={source}
              alt={file.name}
              draggable={false}
              onLoad={(event) => setSize([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              className="max-h-full max-w-full select-none object-contain"
            />
          ) : (
            <video
              key={relative}
              ref={video}
              src={source}
              controls
              playsInline
              autoPlay={autoplay}
              loop={loop}
              onLoadedMetadata={(event) => setSize([event.currentTarget.videoWidth, event.currentTarget.videoHeight])}
              className="max-h-full max-w-full"
            >
              <track kind="captions" />
            </video>
          )}
        </div>

        <ToolbarButton
          label="Previous"
          onClick={() => go(-1)}
          disabled={index === 0}
          className="absolute top-1/2 left-2 -translate-y-1/2 bg-stage/60"
        >
          <PrevIcon />
        </ToolbarButton>
        <ToolbarButton
          label="Next"
          onClick={() => go(1)}
          disabled={index === files.length - 1}
          className="absolute top-1/2 right-2 -translate-y-1/2 bg-stage/60"
        >
          <NextIcon />
        </ToolbarButton>
        </div>

        {showDetails ? (
          <aside aria-label="Details" className="w-80 flex-none overflow-y-auto border-l border-on-stage/20 p-4 text-label">
            <dl className="m-0 flex flex-col gap-3">
              <Detail term="File" value={file.name} mono />
              <Detail term="Dimensions" value={size ? `${size[0]} × ${size[1]}` : "…"} />
              <Detail term="Size" value={formatBytes(file.size)} />
              <Detail
                term="Post date"
                value={postDate ? postDate.toLocaleDateString(undefined, { dateStyle: "long" }) : "Unknown"}
              />
              <div>
                <dt className="text-small text-on-stage/70">Original post</dt>
                <dd className="m-0">
                  {postId ? (
                    <a
                      href={postUrlOf(postId)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 underline underline-offset-4"
                    >
                      Open post
                      <ExternalIcon className="size-3.5" />
                    </a>
                  ) : (
                    "Unknown"
                  )}
                </dd>
              </div>
              {details?.ok ? <Detail term="Path" value={details.absolutePath} mono /> : null}
            </dl>
          </aside>
        ) : null}

        {confirming ? (
          <div className="fixed inset-0 z-10 flex items-center justify-center bg-stage/85 p-4">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-title"
              aria-describedby="delete-body"
              className="w-full max-w-md rounded-lg border border-on-stage/40 bg-stage p-6"
            >
              <h2 id="delete-title" className="m-0 text-title">
                Delete {file.name}?
              </h2>
              <p id="delete-body" className="mt-2 mb-0 text-body text-on-stage/80">
                {recycle ? "It moves to the Recycle Bin." : "It is deleted for good."} grabberX still remembers it in the
                archive, so a later update will not download it again.
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <Button variant="secondary" autoFocus onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="secondary" className="text-danger" loading={busy} onClick={() => void confirmDelete()}>
                  Delete
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div role="status" aria-live="polite" className="min-h-6 border-t border-on-stage/20 px-4 py-1 text-small text-on-stage/80">
        {status}
      </div>
    </div>
  );
}

function Detail({ term, value, mono = false }: { term: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-small text-on-stage/70">{term}</dt>
      <dd className={`m-0 break-all ${mono ? "font-mono text-code" : ""}`}>{value}</dd>
    </div>
  );
}
