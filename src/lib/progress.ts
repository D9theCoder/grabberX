import type { JobSpec, RunProgress } from "@/lib/spec";

export const SPEED_WINDOW_MS = 15_000;
/** Below these, a rate is mostly noise and an ETA would swing wildly. */
const MIN_ETA_ELAPSED_MS = 5_000;
const MIN_ETA_ITEMS = 3;
const MAX_ETA_SECONDS = 100 * 3600;

type FileKind = "saved" | "skipped";

interface Sample {
  at: number;
  bytes: number;
  /** "part" is growth of an unfinished file: it counts towards speed, not towards finished files. */
  kind: FileKind | "part";
  /** The file finished a post not seen before. The totals sites report count posts, so the ETA paces by these. */
  newPost: boolean;
  /** Seconds since the previous finished file: the time this file took, as far as anyone can tell. */
  seconds: number;
}

/** Time spent on, and posts finished by, one kind of file. */
interface Pace {
  seconds: number;
  posts: number;
}

/** What is known about a finished file besides its size. */
export interface FinishedFile {
  /** Its file name, matching the one passed to `recordPart` while it downloaded. */
  key?: string;
  /** The post it belongs to (`postIdOf`); a file without one counts as a post of its own. */
  post?: string;
}

/** A reading of a `.part` file is at most one poll late; a finished name older than this cannot race one any more. */
const FINISHED_KEPT_MS = 10_000;

const emptyPace = (): Record<FileKind, Pace> => ({
  saved: { seconds: 0, posts: 0 },
  skipped: { seconds: 0, posts: 0 },
});

/**
 * Speed and ETA of one run. Every gallery-dl process of the run (parallel workers included) reports into
 * the same tracker, so the numbers are the run's total, not one worker's. The window slides with the clock,
 * so speed falls to zero by itself during a rate-limit wait.
 */
export class ProgressTracker {
  private samples: Sample[] = [];
  private bytes = 0;
  private total: number | undefined;
  private lastFileAt: number;
  private readonly runPace = emptyPace();
  /** Size of each unfinished file already accounted for, by file name, so its completion adds only the rest. */
  private partBytes = new Map<string, number>();
  /** Of those, the bytes this run downloaded (not found on disk at the start). Dropped if the file never finishes. */
  private partCounted = new Map<string, number>();
  /** A size read just before the rename can arrive after the file finished; it must not count again. */
  private finished = new Map<string, number>();
  /**
   * Every post seen, for the whole run: a post with both images and a video appears in the image pass and again
   * in the video pass, and must count once.
   */
  private posts = new Set<string>();
  private postlessFiles = 0;

  constructor(
    private readonly startedAt: number,
    private readonly windowMs: number = SPEED_WINDOW_MS,
  ) {
    this.lastFileAt = startedAt;
  }

  record(at: number, bytes: number, file: FinishedFile = {}): void {
    let counted = 0;
    if (file.key !== undefined) {
      counted = this.partBytes.get(file.key) ?? 0;
      this.partBytes.delete(file.key);
      this.partCounted.delete(file.key);
      this.finished.set(file.key, at);
    }
    this.finishFile(at, Math.max(0, bytes - counted), "saved", file.post);
  }

  /** A skipped file: it counts towards the posts done, not towards speed. */
  recordSkip(at: number, post?: string): void {
    this.finishFile(at, 0, "skipped", post);
  }

  /**
   * An unfinished file found on disk when its folder started being watched: left by an earlier run, or about to be
   * resumed by this one. Its bytes so far were not downloaded now, so only later growth counts.
   */
  seedPart(key: string, size: number): void {
    if (this.finished.has(key)) return;
    this.partBytes.set(key, Math.max(size, this.partBytes.get(key) ?? 0));
  }

  /** An unfinished file has grown to `size`. Only the growth since the last reading is counted. */
  recordPart(at: number, key: string, size: number): void {
    if (this.finished.has(key)) return;
    const counted = this.partBytes.get(key) ?? 0;
    if (size <= counted) return;
    const growth = size - counted;
    this.partBytes.set(key, size);
    this.partCounted.set(key, (this.partCounted.get(key) ?? 0) + growth);
    this.add({ at, bytes: growth, kind: "part", newPost: false, seconds: 0 });
  }

  setTotal(total: number): void {
    if (Number.isFinite(total) && total > 0) this.total = Math.floor(total);
  }

  snapshot(now: number): RunProgress {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift();
    for (const [key, at] of this.finished) {
      if (now - at > FINISHED_KEPT_MS) this.finished.delete(key);
    }

    let windowBytes = 0;
    let windowFiles = 0;
    const windowPace = emptyPace();
    for (const sample of this.samples) {
      windowBytes += sample.bytes;
      if (sample.kind === "part") continue;
      windowFiles += 1;
      windowPace[sample.kind].seconds += sample.seconds;
      if (sample.newPost) windowPace[sample.kind].posts += 1;
    }
    // Until a full window has passed, divide by the time actually elapsed, or the first seconds read slow.
    const span = Math.min(this.windowMs, now - this.startedAt);
    const seconds = span / 1000;
    const bytesPerSec = span >= 1000 ? windowBytes / seconds : 0;
    const itemsPerSec = span >= 1000 ? windowFiles / seconds : 0;

    const progress: RunProgress = {
      bytes: this.bytes,
      bytesPerSec: Math.round(bytesPerSec),
      itemsPerSec: Math.round(itemsPerSec * 100) / 100,
    };
    if (this.total !== undefined) {
      const done = this.posts.size + this.postlessFiles;
      progress.total = this.total;
      progress.processed = done;
      const eta = this.estimate(this.total - done, done, windowPace, now);
      if (eta !== undefined) progress.etaSeconds = eta;
    }
    return progress;
  }

  /** The closing numbers: average speed over the whole run instead of the last window. */
  finish(now: number): RunProgress {
    // Bytes of files that never finished (stopped, failed, swept) were downloaded but not kept.
    let unsaved = 0;
    for (const bytes of this.partCounted.values()) unsaved += bytes;
    this.partCounted.clear();
    this.bytes = Math.max(0, this.bytes - unsaved);
    const seconds = Math.max(1, (now - this.startedAt) / 1000);
    const progress = this.snapshot(now);
    return {
      ...progress,
      bytesPerSec: Math.round(this.bytes / seconds),
      itemsPerSec: 0,
      etaSeconds: undefined,
      done: true,
    };
  }

  /**
   * Seconds left. A saved post takes as long as its download; a skipped one almost no time. Neither alone
   * predicts the rest: an update run saves the new posts first and then skips the old ones, a resumed run does
   * the opposite. So the posts left are split by the run's saved-to-skipped ratio so far, and each part is
   * timed by its own kind, from the recent window when it has any, else from the whole run.
   */
  private estimate(
    remaining: number,
    done: number,
    windowPace: Record<FileKind, Pace>,
    now: number,
  ): number | undefined {
    if (remaining <= 0 || done < MIN_ETA_ITEMS || now - this.startedAt < MIN_ETA_ELAPSED_MS) return undefined;
    const counted = this.runPace.saved.posts + this.runPace.skipped.posts;
    if (counted === 0) return undefined;
    let eta = 0;
    for (const kind of ["saved", "skipped"] as const) {
      const share = this.runPace[kind].posts / counted;
      if (share === 0) continue;
      const pace = windowPace[kind].posts > 0 ? windowPace[kind] : this.runPace[kind];
      eta += remaining * share * (pace.seconds / pace.posts);
    }
    if (!Number.isFinite(eta) || eta > MAX_ETA_SECONDS) return undefined;
    return Math.max(1, Math.ceil(eta));
  }

  private finishFile(at: number, bytes: number, kind: FileKind, post: string | undefined): void {
    const seconds = Math.max(0, (at - this.lastFileAt) / 1000);
    this.lastFileAt = Math.max(this.lastFileAt, at);
    const newPost = this.countPost(post);
    this.runPace[kind].seconds += seconds;
    if (newPost) this.runPace[kind].posts += 1;
    this.add({ at, bytes, kind, newPost, seconds });
  }

  private countPost(post: string | undefined): boolean {
    if (post === undefined) {
      this.postlessFiles += 1;
      return true;
    }
    if (this.posts.has(post)) return false;
    this.posts.add(post);
    return true;
  }

  private add(sample: Sample): void {
    this.bytes += sample.bytes;
    this.samples.push(sample);
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

/**
 * Sites whose profile reports its number of posts with media up front, and where that number matches what a
 * run finds. Instagram reports one too (`user.media_count`), but it counted 129 posts on a profile whose feed
 * held 91, so it is left out: the bar would end a finished run at 70%.
 */
const TOTAL_SITES: ReadonlySet<JobSpec["site"]> = new Set(["x"]);

/** The post counts only exist on some sites, and only mean something for a whole-account run. */
export function totalEligible(spec: JobSpec): boolean {
  if (!TOTAL_SITES.has(spec.site)) return false;
  if (spec.media !== "all") return false;
  const { dateFrom, dateTo, advanced } = spec;
  if (dateFrom || dateTo) return false;
  if (advanced.range || advanced.abortAfterSkipped) return false;
  return true;
}

/**
 * gallery-dl `-j` prints `[[type, {metadata}], ...]`. On X every item carries the timeline owner's
 * `user.media_count`: the number of posts with media, not of files (a post can hold several). The tweet author
 * is a fallback for the rare item without it.
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

/**
 * The post a downloaded file belongs to, from gallery-dl's default file names: X writes `{tweet_id}_{n}`,
 * Instagram `{post_id}_{media_id}` for an album and `{post_id}` for a single file.
 */
export function postIdOf(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? "";
  return /^(\d+)(?:_\d+)?\.[A-Za-z0-9]+$/.exec(name)?.[1];
}
