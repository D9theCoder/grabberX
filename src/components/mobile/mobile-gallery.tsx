"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { FolderCard } from "@/components/gallery/folder-card";
import { formatDuration, postDateOf, postIdOf, postUrlOf, sortFiles } from "@/components/gallery/format";
import type { KindFilter, SortKey } from "@/components/gallery/format";
import { AutoplayIcon, LoopIcon } from "@/components/gallery/gallery-icons";
import { mediaUrl, versionOf } from "@/components/gallery/thumbnail";
import { Toolbar, ToolbarButton } from "@/components/gallery/toolbar";
import type { MediaFile } from "@/components/gallery/types";
import {
  doubleTapScale,
  FIT_VIEW,
  mediaBoundsOf,
  panZoomView,
  pinchZoomAt,
  zoomAt,
  type ZoomView,
} from "@/components/gallery/zoom";
import { CheckIcon, CrossIcon, DownloadIcon, ExternalIcon, InfoIcon, PlayIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { formatBytes, formatCount } from "@/lib/format";

const CHUNK = 90;
const GRID_GAP = 4;
const SWIPE_GAP = 16;
const SWIPE_MS = 240;
const DRAG_THRESHOLD = 6;
const HOLD_MOVE_TOLERANCE = 8;
const LONG_PRESS_MS = 400;
const SELECTING_HOLD_MS = 75;
const EDGE_SCROLL = 72;

function viewerMediaUrl(
  account: string,
  path: string,
  file: MediaFile,
  options: { download?: boolean } = {},
): string {
  const base = mediaUrl(account, path, file.name);
  return options.download ? `${base}&download=1` : base;
}

/** One file downloads as itself; several come back as one zip, as on the desktop. The server writes nothing. */
function startDownload(account: string, path: string, files: MediaFile[]): void {
  if (files.length === 0) return;
  if (files.length === 1) {
    const link = document.createElement("a");
    link.href = viewerMediaUrl(account, path, files[0]!, { download: true });
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
function VideoPreview({ source }: { source: string }) {
  return (
    <video
      src={`${source}#t=0.1`}
      preload="metadata"
      muted
      playsInline
      tabIndex={-1}
      aria-hidden="true"
      onLoadedMetadata={(event) => {
        if (event.currentTarget.currentTime === 0) event.currentTarget.currentTime = 0.1;
      }}
      className="pointer-events-none size-full object-cover"
    />
  );
}

function MobileTile({
  file,
  account,
  path,
  index,
  selecting,
  selected,
  duration,
  onPress,
}: {
  file: MediaFile;
  account: string;
  path: string;
  index: number;
  selecting: boolean;
  selected: boolean;
  duration?: number;
  onPress: (index: number) => void;
}) {
  const [broken, setBroken] = useState(false);
  const [posterMissing, setPosterMissing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const source = mediaUrl(account, path, file.name);
  const thumb = mediaUrl(account, path, file.name, 480, versionOf(file));
  const imgSrc = file.kind === "image" && posterMissing ? source : thumb;

  const handleError = useCallback(() => {
    if (file.kind === "video") setPosterMissing(true);
    else if (!posterMissing && file.kind === "image") setPosterMissing(true);
    else setBroken(true);
  }, [file.kind, posterMissing]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) setLoaded(true);
    else handleError();
  }, [imgSrc, handleError]);

  return (
    <button
      type="button"
      data-index={index}
      data-name={file.name}
      aria-label={file.name}
      aria-pressed={selecting ? selected : undefined}
      onClick={() => onPress(index)}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        "group relative aspect-square select-none overflow-hidden rounded-sm border bg-sunken p-0 [-webkit-touch-callout:none] transition-colors duration-120",
        selected ? "border-ink" : "border-line hover:border-ink-2",
      )}
    >
      {file.kind === "video" && posterMissing ? (
        <VideoPreview source={source} />
      ) : broken ? null : (
        // 480 is the size the warmer pre-builds; asking for 240 would decode every thumbnail on demand.
        // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from our own route with their own cache headers
        <img
          ref={imgRef}
          src={imgSrc}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={handleError}
          className={cn("size-full object-cover transition-opacity duration-120", loaded ? "opacity-100" : "opacity-0")}
        />
      )}
      {selected ? <span className="pointer-events-none absolute inset-0 rounded-sm shadow-[inset_0_0_0_2px_var(--color-ink)]" /> : null}
      {selecting ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-sm border-[1.5px]",
            selected ? "border-ink bg-ink text-on-ink" : "border-on-stage bg-stage/40 text-on-stage",
          )}
        >
          {selected ? <CheckIcon className="size-3.5" strokeWidth={2.5} /> : null}
        </span>
      ) : null}
      {file.kind === "video" ? (
        <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded-sm bg-stage/80 px-1.5 py-0.5 text-small text-on-stage tabular-nums">
          <PlayIcon className="size-3" />
          {duration !== undefined ? formatDuration(duration) : null}
        </span>
      ) : null}
    </button>
  );
}

function MobileVideoSlide({
  src,
  active,
  autoplay,
  loop,
  style,
  onMediaNode,
  onSize,
}: {
  src: string;
  active: boolean;
  autoplay: boolean;
  loop: boolean;
  style?: CSSProperties;
  onMediaNode?: (node: HTMLVideoElement | null) => void;
  onSize: (size: { width: number; height: number }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (active) {
      onMediaNode?.(element);
      if (autoplay && element.paused) void element.play().catch(() => {});
    } else if (!element.paused) {
      element.pause();
    }
  }, [active, autoplay, onMediaNode]);

  return (
    <video
      ref={videoRef}
      src={active ? src : `${src}#t=0.1`}
      preload={active ? "auto" : "metadata"}
      controls={active}
      autoPlay={active && autoplay}
      loop={active && loop}
      muted={!active}
      playsInline
      style={style}
      onLoadedMetadata={(event) => {
        if (active) {
          onSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
        }
      }}
      className={`max-h-full max-w-full touch-none ${active ? "" : "pointer-events-none"}`}
    >
      <track kind="captions" />
    </video>
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
  const stageRef = useRef<HTMLDivElement>(null);
  const activeMediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const swipe = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    axis: "x" | "y" | null;
  } | null>(null);
  const pinch = useRef<{
    startDist: number;
    startPx: number;
    startPy: number;
    startView: ZoomView;
  } | null>(null);
  const pan = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDeltaRef = useRef<number>(0);

  const [dragX, setDragX] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const [zoomAnimating, setZoomAnimating] = useState(false);
  const [loop, setLoop] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const [info, setInfo] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const indexRef = useRef(index);
  indexRef.current = index;
  const viewRef = useRef(view);
  viewRef.current = view;

  const updateView = useCallback((next: ZoomView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const resetZoom = useCallback(
    (animate = true) => {
      setZoomAnimating(animate);
      updateView(FIT_VIEW);
    },
    [updateView],
  );

  const setActiveMedia = useCallback((node: HTMLImageElement | HTMLVideoElement | null) => {
    if (node) activeMediaRef.current = node;
  }, []);

  const finalizeSwipe = useCallback(() => {
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    const delta = pendingDeltaRef.current;
    pendingDeltaRef.current = 0;
    setAnimating(false);
    setDragX(0);
    if (delta !== 0) {
      const next = indexRef.current + delta;
      if (next >= 0 && next < files.length) {
        setSize(null);
        setZoomAnimating(false);
        updateView(FIT_VIEW);
        lastTap.current = null;
        onIndex(next);
      }
    }
  }, [files.length, onIndex, updateView]);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < files.length) {
        setSize(null);
        setZoomAnimating(false);
        updateView(FIT_VIEW);
        lastTap.current = null;
        onIndex(next);
      }
    },
    [index, files.length, onIndex, updateView],
  );

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") {
        setZoomAnimating(true);
        updateView(
          zoomAt(
            viewRef.current,
            viewRef.current.scale * 1.5,
            0,
            0,
            mediaBoundsOf(stageRef.current, activeMediaRef.current),
          ),
        );
      } else if (event.key === "-") {
        setZoomAnimating(true);
        updateView(
          zoomAt(
            viewRef.current,
            viewRef.current.scale / 1.5,
            0,
            0,
            mediaBoundsOf(stageRef.current, activeMediaRef.current),
          ),
        );
      } else if (event.key === "0") {
        resetZoom(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, resetZoom, updateView]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    function onTouchMove(event: TouchEvent) {
      if (swipe.current?.axis === "x" || pointers.current.size > 1 || viewRef.current.scale > 1.01) {
        event.preventDefault();
      }
    }
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => element.removeEventListener("touchmove", onTouchMove);
  }, []);

  function inVideoControlBar(target: EventTarget | null, clientY: number): boolean {
    if (!(target instanceof HTMLVideoElement)) return false;
    const rect = target.getBoundingClientRect();
    return clientY > rect.bottom - 52;
  }

  function handleDoubleTap(clientX: number, clientY: number) {
    if (viewRef.current.scale > 1.01) {
      resetZoom(true);
      return;
    }
    const stageEl = stageRef.current;
    const mediaEl = activeMediaRef.current;
    if (!stageEl || !mediaEl) return;
    const rect = stageEl.getBoundingClientRect();
    const px = clientX - rect.left - rect.width / 2;
    const py = clientY - rect.top - rect.height / 2;
    const intrinsicWidth =
      mediaEl instanceof HTMLVideoElement
        ? mediaEl.videoWidth
        : mediaEl instanceof HTMLImageElement
          ? mediaEl.naturalWidth
          : 0;
    const targetScale = doubleTapScale(intrinsicWidth, mediaEl.clientWidth, 2.5);
    setZoomAnimating(true);
    updateView(zoomAt(FIT_VIEW, targetScale, px, py, mediaBoundsOf(stageEl, mediaEl)));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLElement && event.target.closest("button")) return;
    if (pointers.current.size === 0) {
      suppressClick.current = false;
      if (viewRef.current.scale <= 1.01 && inVideoControlBar(event.target, event.clientY)) {
        return;
      }
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setZoomAnimating(false);

    if (pointers.current.size === 2 && stageRef.current) {
      swipe.current = null;
      pan.current = null;
      setDragX(0);
      const [a, b] = [...pointers.current.values()];
      const rect = stageRef.current.getBoundingClientRect();
      pinch.current = {
        startDist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        startPx: (a!.x + b!.x) / 2 - rect.left - rect.width / 2,
        startPy: (a!.y + b!.y) / 2 - rect.top - rect.height / 2,
        startView: viewRef.current,
      };
      suppressClick.current = true;
      return;
    }

    if (pointers.current.size > 2) return;

    if (animating) finalizeSwipe();

    if (viewRef.current.scale > 1.01) {
      pan.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
      return;
    }

    swipe.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: performance.now(),
      axis: null,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2 && pinch.current && stageRef.current) {
      const [a, b] = [...pointers.current.values()];
      const rect = stageRef.current.getBoundingClientRect();
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const px = (a!.x + b!.x) / 2 - rect.left - rect.width / 2;
      const py = (a!.y + b!.y) / 2 - rect.top - rect.height / 2;
      updateView(
        pinchZoomAt(
          pinch.current.startView,
          pinch.current.startDist,
          pinch.current.startPx,
          pinch.current.startPy,
          dist,
          px,
          py,
          mediaBoundsOf(stageRef.current, activeMediaRef.current),
        ),
      );
      return;
    }

    const activePan = pan.current;
    if (activePan && event.pointerId === activePan.pointerId) {
      const dx = event.clientX - activePan.lastX;
      const dy = event.clientY - activePan.lastY;
      activePan.lastX = event.clientX;
      activePan.lastY = event.clientY;
      if (Math.hypot(event.clientX - activePan.startX, event.clientY - activePan.startY) > DRAG_THRESHOLD) {
        activePan.moved = true;
        suppressClick.current = true;
      }
      updateView(panZoomView(viewRef.current, dx, dy, mediaBoundsOf(stageRef.current, activeMediaRef.current)));
      return;
    }

    const current = swipe.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.axis === null) {
      if (Math.hypot(dx, dy) < 8) return;
      current.axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
      if (current.axis === "y") return;
      suppressClick.current = true;
    }
    if (current.axis !== "x") return;
    const atStart = index === 0 && dx > 0;
    const atEnd = index === files.length - 1 && dx < 0;
    setDragX(atStart || atEnd ? dx * 0.25 : dx);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const isCancel = event.type === "pointercancel";
    const hadPointer = pointers.current.delete(event.pointerId);
    if (!hadPointer) return;

    if (pinch.current) {
      if (pointers.current.size < 2) {
        pinch.current = null;
        if (viewRef.current.scale <= 1.04) {
          resetZoom(true);
        } else if (pointers.current.size === 1) {
          const [remId, remPos] = [...pointers.current.entries()][0]!;
          pan.current = {
            pointerId: remId,
            startX: remPos.x,
            startY: remPos.y,
            lastX: remPos.x,
            lastY: remPos.y,
            moved: true,
          };
        }
      }
      return;
    }

    const activePan = pan.current;
    if (activePan && event.pointerId === activePan.pointerId) {
      const moved = activePan.moved;
      pan.current = null;
      if (!isCancel && !moved) {
        const now = performance.now();
        const prevTap = lastTap.current;
        if (prevTap && now - prevTap.time < 280 && Math.hypot(event.clientX - prevTap.x, event.clientY - prevTap.y) < 28) {
          lastTap.current = null;
          suppressClick.current = true;
          handleDoubleTap(event.clientX, event.clientY);
        } else {
          lastTap.current = { time: now, x: event.clientX, y: event.clientY };
        }
      }
      return;
    }

    const current = swipe.current;
    if (!current || event.pointerId !== current.pointerId) return;
    swipe.current = null;
    if (current.axis !== "x") {
      setDragX(0);
      if (
        !isCancel &&
        current.axis === null &&
        Math.hypot(event.clientX - current.startX, event.clientY - current.startY) <= 8 &&
        !inVideoControlBar(event.target, event.clientY)
      ) {
        const now = performance.now();
        const prevTap = lastTap.current;
        if (prevTap && now - prevTap.time < 280 && Math.hypot(event.clientX - prevTap.x, event.clientY - prevTap.y) < 28) {
          lastTap.current = null;
          suppressClick.current = true;
          handleDoubleTap(event.clientX, event.clientY);
        } else {
          lastTap.current = { time: now, x: event.clientX, y: event.clientY };
        }
      }
      return;
    }

    const dx = event.clientX - current.startX;
    const dt = Math.max(1, performance.now() - current.startTime);
    const velocity = Math.abs(dx) / dt;
    const width = stageRef.current?.clientWidth || window.innerWidth;
    const passed = Math.abs(dx) > Math.min(90, width * 0.22) || (velocity > 0.35 && Math.abs(dx) > 24);
    let delta = 0;
    if (passed && dx < 0 && index < files.length - 1) delta = 1;
    else if (passed && dx > 0 && index > 0) delta = -1;

    pendingDeltaRef.current = delta;
    setAnimating(true);
    setDragX(delta === 0 ? 0 : -delta * (width + SWIPE_GAP));
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(finalizeSwipe, SWIPE_MS + 30);
  }

  if (!file) return null;
  const postId = postIdOf(file.name);
  const posted = postId ? postDateOf(postId) : null;
  const zoomed = view.scale > 1.01;
  const activeMediaStyle: CSSProperties = {
    transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
    transition: zoomAnimating ? "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)" : "none",
  };
  const slides = [-1, 0, 1]
    .map((offset) => ({ offset, slideIndex: index + offset, slideFile: files[index + offset] }))
    .filter((item): item is { offset: number; slideIndex: number; slideFile: MediaFile } => Boolean(item.slideFile));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${file.name}, ${index + 1} of ${files.length}`}
      className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none [--focus:var(--color-on-stage)]"
    >
      <div className="flex items-center justify-between px-2 pt-[env(safe-area-inset-top)]">
        <span className="px-2 text-small tabular-nums" aria-live="polite">
          {index + 1} / {files.length}
        </span>
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
          <ToolbarButton label="Details" pressed={info} onClick={() => setInfo((value) => !value)}>
            <InfoIcon />
          </ToolbarButton>
          <ToolbarButton label="Download" onClick={() => startDownload(account, path, [file])}>
            <DownloadIcon />
          </ToolbarButton>
          <ToolbarButton label="Close" onClick={onClose}>
            <CrossIcon />
          </ToolbarButton>
        </Toolbar>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={stageRef}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClickCapture={(event) => {
            if (suppressClick.current) {
              event.preventDefault();
              event.stopPropagation();
              suppressClick.current = false;
            }
          }}
          style={{ touchAction: "none" }}
        >
          <div
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && animating) finalizeSwipe();
            }}
            style={{
              transform: `translate3d(${dragX}px, 0, 0)`,
              transition: animating ? `transform ${SWIPE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none",
            }}
            className="relative size-full"
          >
            {slides.map(({ offset, slideFile }) => {
              const src = viewerMediaUrl(account, path, slideFile);
              const active = offset === 0;
              return (
                <div
                  key={slideFile.name}
                  style={{ transform: `translate3d(calc(${offset * 100}% + ${offset * SWIPE_GAP}px), 0, 0)` }}
                  className="absolute inset-0 flex touch-none items-center justify-center"
                >
                  {slideFile.kind === "video" ? (
                    <MobileVideoSlide
                      src={src}
                      active={active}
                      autoplay={autoplay}
                      loop={loop}
                      style={active ? activeMediaStyle : undefined}
                      onMediaNode={active ? setActiveMedia : undefined}
                      onSize={setSize}
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- the original file, streamed by the media route
                    <img
                      ref={active ? setActiveMedia : undefined}
                      src={src}
                      alt={active ? slideFile.name : ""}
                      draggable={false}
                      style={active ? activeMediaStyle : undefined}
                      onLoad={(event) => {
                        if (active) {
                          setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                        }
                      }}
                      className="max-h-full max-w-full touch-none select-none object-contain"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {zoomed ? (
          <button
            type="button"
            aria-label="Reset zoom"
            onClick={() => resetZoom(true)}
            className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/30 bg-black/75 px-3 py-1 text-small text-white tabular-nums backdrop-blur-xs"
          >
            {view.scale.toFixed(1)}× · Reset
          </button>
        ) : null}
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
                <a href={postUrlOf(postId)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline">
                  Open on X
                  <ExternalIcon className="size-3.5" />
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <div className="h-[env(safe-area-inset-bottom)]" />
    </div>
  );
}

interface DragState {
  pointerId: number;
  startIndex: number;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
  remove: boolean;
  base: ReadonlySet<string>;
  lastTarget: number;
  frame: number;
}

function gridTileAt(element: HTMLElement, clientX: number, clientY: number, count: number): number | null {
  if (count <= 0) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) return null;
  const columns = Math.max(1, getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length);
  const cell = (rect.width - GRID_GAP * (columns - 1)) / columns;
  const stride = cell + GRID_GAP;
  if (stride <= 0) return null;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const col = Math.max(0, Math.min(columns - 1, Math.floor((x + GRID_GAP / 2) / stride)));
  const row = Math.max(0, Math.floor((y + GRID_GAP / 2) / stride));
  return Math.max(0, Math.min(count - 1, row * columns + col));
}

export interface MobileGalleryProps {
  account: string;
  path: string;
  base: string;
  folders: string[];
  files: MediaFile[];
  initialDurations?: Record<string, number>;
  maxZipFiles: number;
  maxZipBytes: number;
}

/**
 * Grid for a phone: desktop controls and monochrome tile styling over the mobile 3/4-column square grid,
 * iOS/Android-style hold-and-drag block selection, and a swipe-animated fullscreen viewer.
 */
export function MobileGallery({
  account,
  path,
  base,
  folders,
  files,
  initialDurations,
  maxZipFiles,
  maxZipBytes,
}: MobileGalleryProps) {
  const [sort, setSort] = useState<SortKey>("newest");
  const [kind, setKind] = useState<KindFilter>("all");
  const shown = useMemo(
    () => sortFiles(files.filter((file) => kind === "all" || file.kind === kind), sort),
    [files, kind, sort],
  );
  const [visible, setVisible] = useState(CHUNK);
  const [open, setOpen] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState(false);

  const container = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pushed = useRef(false);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<DragState | null>(null);

  const selectingRef = useRef(selecting);
  selectingRef.current = selecting;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const durations = initialDurations ?? {};

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
  }, [visible]);

  // A file that left the view (filter change) leaves the selection too.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const names = new Set(shown.map((file) => file.name));
      const kept = [...current].filter((name) => names.has(name));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [shown]);

  // The Android back gesture closes the viewer instead of leaving the folder.
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
      setOpen(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Once hold-to-select activates, prevent native scroll on touchmove so the finger can sweep across tiles.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    function onTouchMove(event: TouchEvent) {
      if (drag.current?.active) event.preventDefault();
    }
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => element.removeEventListener("touchmove", onTouchMove);
  }, [shown.length]);

  useEffect(() => {
    return () => {
      if (drag.current?.timer) clearTimeout(drag.current.timer);
      if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
      if (suppressTimer.current) clearTimeout(suppressTimer.current);
    };
  }, []);

  const openAt = useCallback((index: number) => {
    if (!pushed.current) {
      window.history.pushState({ viewer: true }, "");
      pushed.current = true;
    }
    setOpen(index);
  }, []);

  const close = useCallback(() => {
    if (pushed.current) window.history.back();
    else setOpen(null);
  }, []);

  const toggle = useCallback((name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const onPress = useCallback(
    (index: number) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      const file = shownRef.current[index];
      if (!file) return;
      if (selectingRef.current) toggle(file.name);
      else openAt(index);
    },
    [toggle, openAt],
  );

  // ---- Hold and drag block selection ----------------------------------------------------------------

  const applyRange = useCallback((state: DragState, targetIndex: number) => {
    const low = Math.min(state.startIndex, targetIndex);
    const high = Math.max(state.startIndex, targetIndex);
    const currentFiles = shownRef.current;
    const next = new Set(state.base);
    for (let index = low; index <= high; index++) {
      const name = currentFiles[index]?.name;
      if (!name) continue;
      if (state.remove) next.delete(name);
      else next.add(name);
    }
    setSelected(next);
  }, []);

  const updateDragFromClient = useCallback(
    (state: DragState) => {
      const element = container.current;
      if (!element) return;
      const target = gridTileAt(element, state.clientX, state.clientY, shownRef.current.length);
      if (target !== null && target !== state.lastTarget) {
        state.lastTarget = target;
        setVisible((current) => (target >= current ? target + CHUNK : current));
        applyRange(state, target);
      }
    },
    [applyRange],
  );

  const edgeScroll = useCallback(() => {
    const state = drag.current;
    if (!state?.active) return;
    let delta = 0;
    if (state.clientY < EDGE_SCROLL) delta = -Math.ceil((EDGE_SCROLL - state.clientY) / 4);
    else if (state.clientY > window.innerHeight - EDGE_SCROLL) {
      delta = Math.ceil((state.clientY - (window.innerHeight - EDGE_SCROLL)) / 4);
    }
    if (delta !== 0) {
      window.scrollBy(0, delta);
      updateDragFromClient(state);
    }
    state.frame = requestAnimationFrame(edgeScroll);
  }, [updateDragFromClient]);

  const activateDrag = useCallback(
    (state: DragState) => {
      if (state.active) return;
      state.active = true;
      suppressClick.current = true;
      setDragging(true);
      setSelecting(true);
      try {
        container.current?.setPointerCapture(state.pointerId);
      } catch {
        /* ignore if synthetic pointer is not active */
      }
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try {
          navigator.vibrate(10);
        } catch {
          /* ignore */
        }
      }
      applyRange(state, state.startIndex);
      state.frame = requestAnimationFrame(edgeScroll);
    },
    [applyRange, edgeScroll],
  );

  function clearPendingHold() {
    const state = drag.current;
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    cancelAnimationFrame(state.frame);
    drag.current = null;
    setDragging(false);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (suppressTimer.current) {
      clearTimeout(suppressTimer.current);
      suppressTimer.current = null;
    }
    suppressClick.current = false;
    if (event.button !== 0 || !container.current) return;
    const tile = (event.target as Element).closest<HTMLElement>("[data-index]");
    if (!tile) return;
    const index = Number(tile.dataset.index);
    const file = shown[index];
    if (!Number.isInteger(index) || !file) return;

    clearPendingHold();
    const base = new Set(selectedRef.current);
    const state: DragState = {
      pointerId: event.pointerId,
      startIndex: index,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      timer: null,
      active: false,
      remove: selectingRef.current && base.has(file.name),
      base,
      lastTarget: index,
      frame: 0,
    };
    drag.current = state;

    if (event.pointerType === "touch" || !selectingRef.current) {
      const delay = selectingRef.current ? SELECTING_HOLD_MS : LONG_PRESS_MS;
      state.timer = setTimeout(() => {
        if (drag.current !== state) return;
        state.timer = null;
        activateDrag(state);
      }, delay);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    state.clientX = event.clientX;
    state.clientY = event.clientY;
    if (!state.active) {
      const distance = Math.hypot(event.clientX - state.startClientX, event.clientY - state.startClientY);
      if (event.pointerType !== "touch" && selectingRef.current) {
        if (distance < DRAG_THRESHOLD) return;
        activateDrag(state);
        updateDragFromClient(state);
      } else if (distance > HOLD_MOVE_TOLERANCE) {
        clearPendingHold();
      }
      return;
    }
    updateDragFromClient(state);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    const wasActive = state.active;
    clearPendingHold();
    if (wasActive) {
      suppressClick.current = true;
      suppressTimer.current = setTimeout(() => {
        suppressClick.current = false;
        suppressTimer.current = null;
      }, 300);
    }
  }

  const chosen = useMemo(() => shown.filter((file) => selected.has(file.name)), [shown, selected]);
  const chosenBytes = chosen.reduce((sum, file) => sum + file.size, 0);
  const overCount = chosen.length > maxZipFiles;
  const overBytes = chosenBytes > maxZipBytes;
  const problem = overCount
    ? `Choose ${formatCount(maxZipFiles)} files or fewer for one zip.`
    : overBytes
      ? "Those files are over 4 GB together. Choose fewer."
      : "";

  const noMedia = files.length === 0 && folders.length === 0;

  return (
    <div className={`flex flex-col gap-5 ${selecting ? "pb-24" : ""}`}>
      {folders.length > 0 ? (
        <section aria-label="Folders" className="flex flex-wrap gap-3">
          {folders.map((name) => (
            <FolderCard key={name} name={name} href={`${base}/${encodeURIComponent(name)}`} />
          ))}
        </section>
      ) : null}

      {files.length > 0 ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Segmented
            label="Show"
            size="sm"
            value={kind}
            onChange={(value) => {
              setKind(value as KindFilter);
              setVisible(CHUNK);
            }}
            options={[
              { value: "all", label: "All" },
              { value: "image", label: "Images" },
              { value: "video", label: "Videos" },
            ]}
          />
          <Segmented
            label="Sort by"
            size="sm"
            value={sort}
            onChange={(value) => setSort(value as SortKey)}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "name", label: "Name" },
            ]}
          />
        </div>
      ) : null}

      {noMedia ? (
        <p className="text-body text-ink-2">
          No files here yet.{" "}
          <Link
            href={path === "" ? "/m" : `/m/${encodeURIComponent(account)}`}
            className="underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            {path === "" ? "Back to the library" : `Back to ${account}`}
          </Link>
        </p>
      ) : files.length > 0 && shown.length === 0 ? (
        <p className="text-body text-ink-2">Nothing matches this filter in this folder.</p>
      ) : null}

      {shown.length > 0 ? (
        <div
          ref={container}
          role="group"
          aria-label={`${shown.length} files`}
          aria-multiselectable={selecting || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={`grid grid-cols-3 gap-1 select-none sm:grid-cols-4 ${dragging ? "touch-none" : "touch-pan-y"}`}
        >
          {shown.slice(0, visible).map((file, index) => (
            <MobileTile
              key={file.name}
              file={file}
              account={account}
              path={path}
              index={index}
              selecting={selecting}
              selected={selected.has(file.name)}
              duration={durations[file.name]}
              onPress={onPress}
            />
          ))}
        </div>
      ) : null}
      {visible < shown.length ? <div ref={sentinel} className="h-8" /> : null}

      {selecting ? (
        <div
          role="toolbar"
          aria-label="Selection"
          className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 mx-auto max-w-[744px] rounded-lg border border-line-strong bg-surface p-1.5 sm:px-3 sm:py-2"
        >
          <div className="flex items-center gap-1.5 sm:gap-3">
            <div className="flex flex-1 items-center justify-start">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Cancel selection"
                onClick={stopSelecting}
                className="size-8 shrink-0 px-0"
              >
                <CrossIcon className="size-4" />
              </Button>
            </div>

            <span
              className="min-w-0 shrink-0 truncate text-center text-label font-semibold tabular-nums"
              aria-live="polite"
            >
              {chosen.length === 0
                ? "Nothing selected"
                : `${formatCount(chosen.length)} ${chosen.length === 1 ? "file" : "files"} selected`}
            </span>

            <div className="flex flex-1 items-center justify-end gap-0.5 sm:gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set(shown.map((file) => file.name)))}
                className="px-2 sm:px-3"
              >
                <span className="sm:hidden">All</span>
                <span className="hidden sm:inline">Select all</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={chosen.length === 0}
                onClick={() => setSelected(new Set())}
                className="px-2 sm:px-3"
              >
                Clear
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={chosen.length === 0 || problem !== ""}
                onClick={() => startDownload(account, path, chosen)}
                className="size-8 shrink-0 px-0 sm:w-auto sm:px-3"
              >
                <DownloadIcon className="size-4" />
                <span className="sr-only sm:not-sr-only">Download</span>
              </Button>
            </div>
          </div>
          {problem ? (
            <p role="alert" className="mt-1 mb-0 text-center text-small text-danger">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}

      {open !== null ? (
        <Viewer files={shown} index={open} account={account} path={path} onIndex={setOpen} onClose={close} />
      ) : null}
    </div>
  );
}
