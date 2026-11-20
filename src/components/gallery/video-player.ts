/** Playback speeds of the stepped slider, slowest to fastest. */
export const PLAYBACK_SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3] as const;
export const DEFAULT_SPEED = 1;
export const SKIP_SECONDS = 5;

export function speedIndex(rate: number): number {
  if (!Number.isFinite(rate)) return PLAYBACK_SPEEDS.indexOf(DEFAULT_SPEED);
  let best = 0;
  for (let index = 1; index < PLAYBACK_SPEEDS.length; index++) {
    if (Math.abs(PLAYBACK_SPEEDS[index]! - rate) < Math.abs(PLAYBACK_SPEEDS[best]! - rate)) best = index;
  }
  return best;
}

export function formatSpeed(rate: number): string {
  return `${rate}×`;
}

/** Where a skip lands: never before the start, never past the end (when the length is known). */
export function skipTarget(current: number, duration: number, delta: number): number {
  const target = Math.max(0, (Number.isFinite(current) ? current : 0) + delta);
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration, target) : target;
}

export type TapRegion = "back" | "forward" | "middle";

/** A double tap on the left third skips back, on the right third skips forward; the middle keeps the zoom toggle. */
export function tapRegion(clientX: number, left: number, width: number): TapRegion {
  if (!(width > 0)) return "middle";
  const ratio = (clientX - left) / width;
  if (ratio < 1 / 3) return "back";
  if (ratio > 2 / 3) return "forward";
  return "middle";
}

/**
 * What the player remembers between visits. Speed is not here on purpose: a viewer that reopened at 0.1x
 * would look broken, so each viewer starts at normal speed.
 */
export interface VideoPrefs {
  autoplay: boolean;
  volume: number;
  muted: boolean;
}

export const DEFAULT_PREFS: VideoPrefs = { autoplay: false, volume: 1, muted: false };

/** Reads what the player stored; anything missing or malformed falls back to the default, so a bad value never breaks playback. */
export function parsePrefs(raw: string | null): VideoPrefs {
  if (raw === null) return DEFAULT_PREFS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof data !== "object" || data === null) return DEFAULT_PREFS;
  const record = data as Record<string, unknown>;
  const volume = typeof record.volume === "number" && Number.isFinite(record.volume) ? record.volume : DEFAULT_PREFS.volume;
  return {
    autoplay: record.autoplay === true,
    volume: Math.min(1, Math.max(0, volume)),
    muted: record.muted === true,
  };
}
