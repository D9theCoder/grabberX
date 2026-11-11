"use client";

import { useState } from "react";
import { PlayIcon } from "@/components/icons";
import { formatDuration } from "@/components/gallery/format";
import type { MediaFile } from "@/components/gallery/types";

export interface ThumbnailProps {
  file: MediaFile;
  account: string;
  path: string;
  index: number;
  width: number;
  height: number;
  /** The one tile in the grid that takes Tab. */
  active: boolean;
  onOpen: (index: number) => void;
  onActivate: (index: number) => void;
}

export function mediaUrl(account: string, path: string, name: string, thumb?: 240 | 480): string {
  const relative = path === "" ? name : `${path}/${name}`;
  const params = new URLSearchParams({ account, path: relative });
  if (thumb) params.set("thumb", String(thumb));
  return `/api/media?${params.toString()}`;
}

/**
 * One tile. A button named after the file. Images load a small WebP and fall back to the original (scaled by
 * the browser) if thumbnails are unavailable; videos show their first frame and their length.
 */
export function Thumbnail({ file, account, path, index, width, height, active, onOpen, onActivate }: ThumbnailProps) {
  const [fallback, setFallback] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const source = mediaUrl(account, path, file.name);

  return (
    <button
      type="button"
      data-index={index}
      aria-label={file.name}
      tabIndex={active ? 0 : -1}
      onClick={() => onOpen(index)}
      onFocus={() => onActivate(index)}
      style={{ width, height }}
      className="group relative block flex-none overflow-hidden rounded-sm border border-line bg-sunken p-0 transition-colors duration-120 hover:border-ink-2"
    >
      {file.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from our own route, next/image would re-encode them
        <img
          src={fallback ? source : mediaUrl(account, path, file.name, width > 240 || height > 240 ? 480 : 240)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFallback(true)}
          className="size-full object-cover"
        />
      ) : (
        <>
          <video
            src={`${source}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            aria-hidden="true"
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
            className="size-full object-cover"
          />
          <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded-sm bg-stage/80 px-1.5 py-0.5 text-small text-on-ink tabular-nums">
            <PlayIcon className="size-3" />
            {duration !== null ? formatDuration(duration) : null}
          </span>
        </>
      )}
    </button>
  );
}
