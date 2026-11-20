import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_PREFS, parsePrefs, skipTarget } from "@/components/gallery/video-player";
import type { VideoPrefs } from "@/components/gallery/video-player";

const STORAGE_KEY = "grabberx.video-player";

const listeners = new Set<() => void>();
let stored: { raw: string | null; prefs: VideoPrefs } = { raw: null, prefs: DEFAULT_PREFS };
// Private windows and blocked site data make storage throw; the player then keeps its choices for this page only.
let storageBroken = false;
let memoryRaw: string | null = null;

function readRaw(): string | null {
  if (storageBroken) return memoryRaw;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    storageBroken = true;
    return memoryRaw;
  }
}

function getSnapshot(): VideoPrefs {
  const raw = readRaw();
  if (raw !== stored.raw) stored = { raw, prefs: parsePrefs(raw) };
  return stored.prefs;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function updateVideoPrefs(patch: Partial<VideoPrefs>): void {
  const raw = JSON.stringify({ ...getSnapshot(), ...patch });
  memoryRaw = raw;
  if (!storageBroken) {
    try {
      window.localStorage.setItem(STORAGE_KEY, raw);
    } catch {
      storageBroken = true;
    }
  }
  for (const listener of listeners) listener();
}

/**
 * Autoplay, volume and mute, kept between visits. The server snapshot is the default so a viewer that
 * renders on the server (`?file=`) hydrates cleanly; the stored values arrive right after.
 */
export function useVideoPrefs(): VideoPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_PREFS);
}

export interface VideoState {
  paused: boolean;
  time: number;
  /** 0 until the file's length is known. */
  duration: number;
}

const IDLE: VideoState = { paused: true, time: 0, duration: 0 };
const STATE_EVENTS = ["play", "pause", "timeupdate", "seeking", "seeked", "durationchange", "loadedmetadata", "emptied", "ended"] as const;

export function useVideoState(video: HTMLVideoElement | null): VideoState {
  const [state, setState] = useState<VideoState>(IDLE);
  useEffect(() => {
    if (!video) {
      setState(IDLE);
      return;
    }
    const read = () => {
      const next: VideoState = {
        paused: video.paused,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      };
      setState((previous) =>
        previous.paused === next.paused && previous.time === next.time && previous.duration === next.duration ? previous : next,
      );
    };
    read();
    for (const name of STATE_EVENTS) video.addEventListener(name, read);
    return () => {
      for (const name of STATE_EVENTS) video.removeEventListener(name, read);
    };
  }, [video]);
  return state;
}

/**
 * Pushes speed, volume and mute onto the element. Loading a source resets the playback rate to the element's
 * default, so the speed is also set as the default and re-applied once a (new) source starts loading.
 */
export function useVideoSettings(
  video: HTMLVideoElement | null,
  settings: { speed: number; volume: number; muted: boolean },
): void {
  const { speed, volume, muted } = settings;
  useEffect(() => {
    if (!video) return;
    const apply = () => {
      video.defaultPlaybackRate = speed;
      video.playbackRate = speed;
      video.volume = volume;
      video.muted = muted;
    };
    apply();
    video.addEventListener("loadstart", apply);
    video.addEventListener("loadedmetadata", apply);
    return () => {
      video.removeEventListener("loadstart", apply);
      video.removeEventListener("loadedmetadata", apply);
    };
  }, [video, speed, volume, muted]);
}

/** Starts playback when a video appears (or Autoplay is switched on). Started from an effect so a late-arriving setting still works. */
export function useAutoplay(video: HTMLVideoElement | null, enabled: boolean): void {
  useEffect(() => {
    if (video && enabled && video.paused) void video.play().catch(() => {});
  }, [video, enabled]);
}

function subscribeFullscreen(listener: () => void): () => void {
  document.addEventListener("fullscreenchange", listener);
  return () => document.removeEventListener("fullscreenchange", listener);
}

const noopSubscribe = () => () => {};

export function useIsFullscreen(): boolean {
  return useSyncExternalStore(subscribeFullscreen, () => document.fullscreenElement !== null, () => false);
}

export function useCanFullscreen(): boolean {
  return useSyncExternalStore(noopSubscribe, () => document.fullscreenEnabled, () => false);
}

export interface SkipFlashState {
  side: "back" | "forward";
  seconds: number;
  id: number;
}

const FLASH_MS = 650;

/** Skips a video by a number of seconds and shows a short "-5s" / "+5s" cue on the side it went. */
export function useSkipFlash() {
  const [flash, setFlash] = useState<SkipFlashState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const skip = useCallback((video: HTMLVideoElement | null, delta: number) => {
    if (!video) return;
    video.currentTime = skipTarget(video.currentTime, video.duration, delta);
    setFlash((previous) => ({ side: delta < 0 ? "back" : "forward", seconds: Math.abs(delta), id: (previous?.id ?? 0) + 1 }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  return { flash, skip };
}
