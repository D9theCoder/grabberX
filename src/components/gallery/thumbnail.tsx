"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { CheckIcon, PlayIcon } from "@/components/icons";
import { formatDuration } from "@/components/gallery/format";
import type { MediaFile } from "@/components/gallery/types";
import { cn } from "@/lib/cn";

export interface ThumbnailProps {
  file: MediaFile;
  account: string;
  path: string;
  index: number;
  width: number;
  height: number;
  /** The one tile in the grid that takes Tab. */
  active: boolean;
  selecting: boolean;
  selected: boolean;
  /** Length from the media index, when a browser has reported it before. */
  duration?: number;
  onPress: (index: number, event: ReactMouseEvent) => void;
  onActivate: (index: number) => void;
  onMenu: (index: number, event: ReactMouseEvent) => void;
}

/** The same version string the media route puts in its etag, so a thumbnail URL changes only with the file. */
export function versionOf(file: Pick<MediaFile, "size" | "mtimeMs">): string {
  return `${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}`;
}

export function mediaUrl(account: string, path: string, name: string, thumb?: 240 | 480, version?: string): string {
  const relative = path === "" ? name : `${path}/${name}`;
  const params = new URLSearchParams({ account, path: relative });
  if (thumb) params.set("thumb", String(thumb));
  if (version) params.set("v", version);
  return `/api/media?${params.toString()}`;
}

const POSTER_WIDTH = 480;

/** Draws the loaded frame and sends it, with the length, so the next visit shows a cached poster. */
function sendPoster(video: HTMLVideoElement, account: string, relative: string) {
  const params = new URLSearchParams({ account, path: relative, duration: String(video.duration || 0) });
  const send = (body: Blob | null) =>
    void fetch(`/api/media/poster?${params.toString()}`, { method: "POST", body: body ?? new Blob() }).catch(() => {});
  if (!video.videoWidth || !video.videoHeight) return send(null);
  const scale = Math.min(1, POSTER_WIDTH / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return send(null);
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(send, "image/webp", 0.8);
}

function VideoFallback({ source, relative, account, onDuration }: { source: string; relative: string; account: string; onDuration: (seconds: number) => void }) {
  const sent = useRef(false);
  return (
    <video
      src={`${source}#t=0.1`}
      preload="metadata"
      muted
      playsInline
      tabIndex={-1}
      aria-hidden="true"
      onLoadedMetadata={(event) => onDuration(event.currentTarget.duration)}
      onLoadedData={(event) => {
        if (sent.current) return;
        sent.current = true;
        const element = event.currentTarget;
        // The #t=0.1 seek lands a moment after loadeddata; draw once the frame is there.
        const capture = () => sendPoster(element, account, relative);
        if (element.seeking) element.addEventListener("seeked", capture, { once: true });
        else capture();
      }}
      className="size-full object-cover"
    />
  );
}

/**
 * One tile. A button named after the file. Images and videos both show a cached 480 px WebP with a URL that
 * changes only with the file, so a revisited folder paints from the browser cache. A video with no poster
 * yet loads its metadata once, and that first frame becomes the poster.
 */
export const Thumbnail = memo(function Thumbnail({
  file,
  account,
  path,
  index,
  width,
  height,
  active,
  selecting,
  selected,
  duration,
  onPress,
  onActivate,
  onMenu,
}: ThumbnailProps) {
  const [fallback, setFallback] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(duration ?? null);
  const relative = path === "" ? file.name : `${path}/${file.name}`;
  const source = mediaUrl(account, path, file.name);
  const thumb = mediaUrl(account, path, file.name, 480, versionOf(file));

  useEffect(() => {
    if (duration !== undefined) setSeconds(duration);
  }, [duration]);

  return (
    <button
      type="button"
      data-index={index}
      data-name={file.name}
      aria-label={file.name}
      aria-pressed={selecting ? selected : undefined}
      tabIndex={active ? 0 : -1}
      onClick={(event) => onPress(index, event)}
      onFocus={() => onActivate(index)}
      onContextMenu={(event) => onMenu(index, event)}
      style={{ width, height }}
      className={cn(
        "group relative block flex-none overflow-hidden rounded-sm border bg-sunken p-0 transition-colors duration-120",
        selected ? "border-ink" : "border-line hover:border-ink-2",
      )}
    >
      {file.kind === "image" || !fallback ? (
        // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from our own route, next/image would re-encode them
        <img
          src={file.kind === "image" && fallback ? source : thumb}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFallback(true)}
          className={cn("size-full object-cover transition-opacity duration-120", loaded ? "opacity-100" : "opacity-0")}
        />
      ) : (
        <VideoFallback source={source} relative={relative} account={account} onDuration={setSeconds} />
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
          {seconds !== null ? formatDuration(seconds) : null}
        </span>
      ) : null}
    </button>
  );
});
