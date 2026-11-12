import type { ScheduleSettings } from "@/lib/schedule";

export type SiteId = "x" | "instagram" | "bluesky" | "pixiv" | "reddit" | "url";
export type Media = "images" | "videos" | "all";
export type CookieBrowser = "firefox" | "chrome" | "edge" | "none";

export type Layout =
  | { kind: "byType" }
  | { kind: "byTypeYear" }
  | { kind: "byMonth" }
  | { kind: "flat" }
  | { kind: "custom"; template: string[] };

export interface Advanced {
  imageSize: "orig" | "large" | "medium";
  sleepRequest?: number;
  sleep?: number;
  sleep429?: number;
  retries?: number;
  limitRate?: string;
  filesizeMin?: string;
  filesizeMax?: string;
  abortAfterSkipped?: number;
  range?: number;
  /** gallery-dl processes per step, 1 to 4; absent means one. Only honoured where `parallelBlock` allows it. */
  parallel?: number;
  retweets: boolean;
  replies: boolean;
  writeMetadata: boolean;
  noSkip: boolean;
  cookies: { browser: CookieBrowser; profile?: string };
  proxy?: string;
}

export interface JobSpec {
  site: SiteId;
  /** Normalized handle, or the full URL when site is "url". */
  account: string;
  /** Overrides the <acct> folder name (reserved names, renames). */
  folder?: string;
  media: Media;
  /** ISO yyyy-mm-dd */
  dateFrom?: string;
  dateTo?: string;
  layout: Layout;
  /** "Preview files": runs gallery-dl --simulate. */
  simulate: boolean;
  advanced: Advanced;
}

export interface Step {
  label: "images" | "videos" | "all";
  argv: string[];
  /** Parallel downloads: one argv per worker, each taking every Nth file. `argv` stays the single-process form. */
  workers?: string[][];
}

export interface Settings {
  galleryDlPath: string;
  mediaRoot: string;
  cookies: { browser: CookieBrowser; profile?: string };
  defaultMedia: Media;
  defaultLayout: Layout;
  historyRetention: number;
  /** Global run concurrency, 1 to 3. */
  concurrency: number;
  /** Automatic updates: off by default. */
  schedule: ScheduleSettings;
  /** Account folders the scheduler skips; everything else runs. */
  pausedAccounts: string[];
  /** Desktop app: closing the window hides it in the tray, so scheduled runs and updates keep working. */
  closeToTray: boolean;
}

export type RunStatus =
  | "queued"
  | "running"
  | "stopping"
  | "done"
  | "failed"
  | "stopped"
  | "interrupted";

export type ErrorKind =
  | "auth"
  | "notFound"
  | "rateLimit"
  | "diskFull"
  | "binaryMissing"
  | "unknown";

export interface Counts {
  saved: number;
  skipped: number;
  failed: number;
}

/** Live speed and estimates, computed by the queue from the files that finished. All of the run, not one worker. */
export interface RunProgress {
  /** Bytes downloaded so far, including the growth of files still downloading. */
  bytes: number;
  bytesPerSec: number;
  /** Finished files (saved or skipped) per second, over the recent window. */
  itemsPerSec: number;
  /** Posts with media in the whole account; only where the site reports a count up front (see progress.ts). */
  total?: number;
  /** Posts finished (saved or skipped), set together with `total`. A file whose post is unknown counts as one. */
  processed?: number;
  etaSeconds?: number;
  /** Set on the closing numbers: `bytesPerSec` is then the run average. */
  done?: true;
}

export interface Run {
  /** Time-sortable, e.g. 2026-11-11T09-14-02_username */
  id: string;
  spec: JobSpec;
  steps: Step[];
  status: RunStatus;
  stepIndex: number;
  counts: Counts;
  /** True when the scheduler started it, so History can tell it from a manual run. */
  scheduled?: boolean;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  errorKind?: ErrorKind;
  progress?: RunProgress;
}

/** What the parser and the runner emit while a run is live. */
export type RunEvent =
  | { t: "status"; status: RunStatus; stepIndex: number }
  | { t: "file"; kind: "saved" | "skipped"; path: string }
  | { t: "log"; level: "info" | "warning" | "error"; line: string }
  | { t: "wait"; reason: "rateLimit"; seconds: number; attempt: number; of: number }
  | { t: "counts"; saved: number; skipped: number; failed: number }
  | { t: "progress"; progress: RunProgress };

/** Events sent over SSE: a RunEvent, or the run snapshot sent first on connect. */
export type StreamEvent = RunEvent | { t: "run"; run: Run };

export interface AccountStats {
  images: number;
  videos: number;
  bytes: number;
}

export type DetectedLayout = "byType" | "byTypeYear" | "flat" | "unknown";

export interface LibraryEntry {
  folder: string;
  lastRunAt?: string;
  layout: DetectedLayout;
}

export type AccountHint =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "reserved"; folder: string }
  | {
      kind: "exists";
      folder: string;
      files: number;
      bytes: number;
      lastRunAt?: string;
      layout: DetectedLayout;
    }
  | { kind: "new"; folder: string }
  | { kind: "active"; runId: string };

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const DEFAULT_ADVANCED: Advanced = {
  imageSize: "orig",
  retweets: false,
  // gallery-dl's own default is on. Keeping it means a default run matches the commands in AGENTS.md.
  replies: true,
  writeMetadata: false,
  noSkip: false,
  cookies: { browser: "firefox" },
};

export function createDefaultSpec(settings: Pick<Settings, "defaultMedia" | "defaultLayout" | "cookies">): JobSpec {
  return {
    site: "x",
    account: "",
    media: settings.defaultMedia,
    layout: settings.defaultLayout,
    simulate: false,
    advanced: { ...DEFAULT_ADVANCED, cookies: { ...settings.cookies } },
  };
}
