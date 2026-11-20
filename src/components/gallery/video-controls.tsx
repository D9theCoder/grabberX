"use client";

import { useState } from "react";
import { ExpandIcon } from "@/components/gallery/gallery-icons";
import { formatDuration } from "@/components/gallery/format";
import { Toolbar, ToolbarButton } from "@/components/gallery/toolbar";
import { updateVideoPrefs, useCanFullscreen, useVideoState } from "@/components/gallery/video-hooks";
import type { SkipFlashState } from "@/components/gallery/video-hooks";
import { DEFAULT_SPEED, formatSpeed, PLAYBACK_SPEEDS, SKIP_SECONDS, speedIndex } from "@/components/gallery/video-player";
import type { VideoPrefs } from "@/components/gallery/video-player";
import { PlayIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function PauseIcon() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M8 5v14M16 5v14" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M4 9v6h4l5 4V5L8 9zM16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M4 9v6h4l5 4V5L8 9zM16.5 9.5l5 5M21.5 9.5l-5 5" />
    </svg>
  );
}

function SkipIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg {...SVG_PROPS}>
      <path d={direction === "back" ? "M4 11a8 8 0 1 1 2.3 5.7M4 4v7h7" : "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"} />
      <text x="12" y="16" textAnchor="middle" fontSize="8" fontWeight="600" fill="currentColor" stroke="none">
        {SKIP_SECONDS}
      </text>
    </svg>
  );
}

/** The cue shown on the side a double tap skipped to. Place it inside the stage's positioned wrapper. */
export function SkipFlash({ flash }: { flash: SkipFlashState | null }) {
  if (!flash) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 flex w-1/3 items-center justify-center",
        flash.side === "back" ? "left-0" : "right-0",
      )}
    >
      <span key={flash.id} className="rounded-full bg-stage/70 px-4 py-2 text-label text-on-stage tabular-nums">
        {flash.side === "back" ? "−" : "+"}
        {flash.seconds}s
      </span>
    </div>
  );
}

export interface VideoControlsProps {
  video: HTMLVideoElement | null;
  prefs: VideoPrefs;
  speed: number;
  onSpeedChange: (speed: number) => void;
  onSkip: (delta: number) => void;
  onFullscreen: () => void;
  fullscreen: boolean;
  /** After a pointer drag on a slider, so the viewer can take focus back and keep its keyboard shortcuts. */
  onPointerDone?: () => void;
}

const SLIDER = "min-w-0 cursor-pointer accent-on-stage disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The player's own control bar. It sits next to the stage, not inside it, so zooming the picture never scales
 * the controls, and fullscreen is always the viewer's (never the video's), so zoom keeps working there.
 */
export function VideoControls({ video, prefs, speed, onSpeedChange, onSkip, onFullscreen, fullscreen, onPointerDone }: VideoControlsProps) {
  const state = useVideoState(video);
  const canFullscreen = useCanFullscreen();
  const [speedOpen, setSpeedOpen] = useState(false);
  const playable = video !== null && state.duration > 0;
  const silent = prefs.muted || prefs.volume === 0;
  const time = formatDuration(state.time) || "0:00";
  const length = formatDuration(state.duration) || "0:00";

  function togglePlay() {
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }

  function seek(value: number) {
    if (video) video.currentTime = value;
  }

  return (
    <div role="group" aria-label="Video controls" className="flex flex-none flex-col border-t border-on-stage/20 px-3 pt-2 pb-1 text-on-stage">
      <div className="flex items-center gap-3">
        <span className="w-10 flex-none text-right text-small tabular-nums">{time}</span>
        <input
          type="range"
          aria-label="Seek"
          aria-valuetext={`${time} of ${length}`}
          min={0}
          max={state.duration}
          step={0.1}
          value={Math.min(state.time, state.duration)}
          disabled={!playable}
          onChange={(event) => seek(Number(event.currentTarget.value))}
          onPointerUp={onPointerDone}
          className={cn(SLIDER, "h-6 flex-1")}
        />
        <span className="w-10 flex-none text-small text-on-stage/80 tabular-nums">{length}</span>
      </div>

      <Toolbar label="Playback">
        <ToolbarButton className="shrink-0" label={state.paused ? "Play" : "Pause"} onClick={togglePlay} disabled={!video}>
          {state.paused ? <PlayIcon /> : <PauseIcon />}
        </ToolbarButton>
        <ToolbarButton className="shrink-0" label={`Back ${SKIP_SECONDS} seconds`} onClick={() => onSkip(-SKIP_SECONDS)} disabled={!playable}>
          <SkipIcon direction="back" />
        </ToolbarButton>
        <ToolbarButton className="shrink-0" label={`Forward ${SKIP_SECONDS} seconds`} onClick={() => onSkip(SKIP_SECONDS)} disabled={!playable}>
          <SkipIcon direction="forward" />
        </ToolbarButton>
        <span className="flex-1" />
        <ToolbarButton className="shrink-0" label={silent ? "Unmute" : "Mute"} onClick={() => updateVideoPrefs({ muted: !prefs.muted })}>
          {silent ? <MutedIcon /> : <VolumeIcon />}
        </ToolbarButton>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={prefs.muted ? 0 : prefs.volume}
          onChange={(event) => updateVideoPrefs({ volume: Number(event.currentTarget.value), muted: false })}
          onPointerUp={onPointerDone}
          className={cn(SLIDER, "hidden h-6 w-20 sm:block")}
        />
        <ToolbarButton className="shrink-0" label="Playback speed" pressed={speedOpen} onClick={() => setSpeedOpen((open) => !open)}>
          <span className="text-small tabular-nums">{formatSpeed(speed)}</span>
        </ToolbarButton>
        {speedOpen ? (
          <input
            type="range"
            aria-label="Playback speed"
            aria-valuetext={formatSpeed(speed)}
            title="Double-click to reset to 1×"
            min={0}
            max={PLAYBACK_SPEEDS.length - 1}
            step={1}
            value={speedIndex(speed)}
            onChange={(event) => onSpeedChange(PLAYBACK_SPEEDS[Number(event.currentTarget.value)]!)}
            onDoubleClick={() => onSpeedChange(DEFAULT_SPEED)}
            onPointerUp={onPointerDone}
            className={cn(SLIDER, "h-6 w-24 min-w-10 shrink sm:w-32")}
          />
        ) : null}
        {canFullscreen ? (
          <ToolbarButton className="shrink-0" label={fullscreen ? "Exit fullscreen" : "Fullscreen"} pressed={fullscreen} onClick={onFullscreen}>
            <ExpandIcon />
          </ToolbarButton>
        ) : null}
      </Toolbar>

    </div>
  );
}
