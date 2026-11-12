import type { JobSpec, RunProgress } from "@/lib/spec";

export const SPEED_WINDOW_MS = 15_000;
/** Below these, a rate is mostly noise and an ETA would swing wildly. */
const MIN_ETA_ELAPSED_MS = 5_000;
const MIN_ETA_ITEMS = 3;
const MAX_ETA_SECONDS = 100 * 3600;

interface Sample {
  at: number;
  bytes: number;
}

/**
 * Speed and ETA of one run. Every gallery-dl process of the run (parallel workers included) reports into
 * the same tracker, so the numbers are the run's total, not one worker's. The window slides with the clock,
 * so speed falls to zero by itself during a rate-limit wait.
 */
export class ProgressTracker {
  private samples: Sample[] = [];
  private bytes = 0;
  private total: number | undefined;

  constructor(
    private readonly startedAt: number,
    private readonly windowMs: number = SPEED_WINDOW_MS,
  ) {}

  /** A file finished. Skipped files pass 0 bytes: they count towards the ETA but not towards speed. */
  record(at: number, bytes: number): void {
    this.bytes += bytes;
    this.samples.push({ at, bytes });
  }

  setTotal(total: number): void {
    if (Number.isFinite(total) && total > 0) this.total = Math.floor(total);
  }

  /** `processed` is saved + skipped, taken from the run's counts so the two never disagree. */
  snapshot(now: number, processed: number): RunProgress {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift();

    // Until a full window has passed, divide by the time actually elapsed, or the first seconds read slow.
    const span = Math.min(this.windowMs, now - this.startedAt);
    const windowBytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const bytesPerSec = span >= 1000 ? windowBytes / (span / 1000) : 0;
    const itemsPerSec = span >= 1000 ? this.samples.length / (span / 1000) : 0;

    const progress: RunProgress = {
      bytes: this.bytes,
      bytesPerSec: Math.round(bytesPerSec),
      itemsPerSec: Math.round(itemsPerSec * 100) / 100,
    };
    if (this.total !== undefined) {
      progress.total = this.total;
      progress.processed = processed;
      const remaining = this.total - processed;
      if (
        remaining > 0 &&
        itemsPerSec > 0 &&
        now - this.startedAt >= MIN_ETA_ELAPSED_MS &&
        this.samples.length >= MIN_ETA_ITEMS
      ) {
        const eta = remaining / itemsPerSec;
        if (eta <= MAX_ETA_SECONDS) progress.etaSeconds = Math.ceil(eta);
      }
    }
    return progress;
  }

  /** The closing numbers: average speed over the whole run instead of the last window. */
  finish(now: number, processed: number): RunProgress {
    const seconds = Math.max(1, (now - this.startedAt) / 1000);
    const progress = this.snapshot(now, processed);
    return {
      ...progress,
      bytesPerSec: Math.round(this.bytes / seconds),
      itemsPerSec: 0,
      etaSeconds: undefined,
      done: true,
    };
  }
}

/** Fraction 0..1 for the bar, never 1 while the run is live: the total is an estimate, not a promise. */
export function progressFraction(progress: RunProgress | undefined, finished: boolean): number | null {
  if (!progress?.total || progress.processed === undefined) return null;
  const fraction = progress.processed / progress.total;
  if (finished) return Math.min(1, fraction);
  return Math.min(0.99, fraction);
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSec;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}

/** "about 12 min", "about 1 h 05 min", "under a minute". Coarse on purpose; the estimate is not exact. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The post counts only exist for X, and only mean something for a whole-account run. */
export function totalEligible(spec: JobSpec): boolean {
  if (spec.site !== "x") return false;
  if (spec.media !== "all") return false;
  const { dateFrom, dateTo, advanced } = spec;
  if (dateFrom || dateTo) return false;
  if (advanced.range || advanced.abortAfterSkipped) return false;
  return true;
}

/**
 * gallery-dl `-j` prints `[[type, {metadata}], ...]`. On X every item carries the timeline owner's
 * `user.media_count`; the tweet author is a fallback for the rare item without it.
 */
export function parseProbeTotal(output: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (!Array.isArray(entry)) continue;
    const meta = entry.find((part): part is Record<string, unknown> => typeof part === "object" && part !== null && !Array.isArray(part));
    if (!meta) continue;
    for (const key of ["user", "author"]) {
      const owner = meta[key];
      if (typeof owner !== "object" || owner === null) continue;
      const count = (owner as Record<string, unknown>).media_count;
      if (typeof count === "number" && Number.isFinite(count) && count > 0) return Math.floor(count);
    }
  }
  return undefined;
}
