import "server-only";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { isActiveStatus } from "@/lib/run-copy";
import { compareRunIds } from "@/lib/run-order";
import { envAppDir, envGalleryDl, envHome, envMediaRoot } from "@/server/env";
import { assertSafeMediaRoot, isDeviceName } from "@/server/paths";
import type { Counts, Run, Settings } from "@/lib/spec";

/** A History page never needs more of a log than this, and a run can write many megabytes. */
const LOG_TAIL_BYTES = 512 * 1024;

const COOKIE_BROWSERS = ["firefox", "chrome", "edge", "none"] as const;
const MEDIA = ["images", "videos", "all"] as const;
const RUN_STATUSES = [
  "queued",
  "running",
  "stopping",
  "done",
  "failed",
  "stopped",
  "interrupted",
] as const;

const layoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("byType") }),
  z.object({ kind: z.literal("byTypeYear") }),
  z.object({ kind: z.literal("byMonth") }),
  z.object({ kind: z.literal("flat") }),
  z.object({ kind: z.literal("custom"), template: z.array(z.string()).min(1) }),
]);

const cookiesSchema = z.object({
  browser: z.enum(COOKIE_BROWSERS),
  profile: z.string().trim().min(1).optional(),
});

const settingsShape = z.object({
  galleryDlPath: z.string().trim().min(1, "Enter the path to gallery-dl."),
  mediaRoot: z.string().trim().min(1, "Enter the media folder."),
  cookies: cookiesSchema,
  defaultMedia: z.enum(MEDIA),
  defaultLayout: layoutSchema,
  historyRetention: z
    .number()
    .int()
    .min(10, "History keeps at least 10 runs.")
    .max(2000, "History keeps at most 2000 runs."),
  concurrency: z
    .number()
    .int()
    .min(1, "Run one account at a time or more.")
    .max(3, "At most three runs at a time."),
});

const settingsPatchSchema = settingsShape.partial().strict();
const settingsFileSchema = settingsShape.partial();

const RUN_ID = /^[0-9A-Za-z_.-]{1,160}$/;

export function isValidRunId(id: string): boolean {
  if (!RUN_ID.test(id)) return false;
  // "runs/con.json" would open the CON device on Windows; no id the app allocates looks like this.
  if (isDeviceName(id)) return false;
  return !id.includes("..");
}

function assertRunId(id: string): void {
  if (!isValidRunId(id)) {
    throw new Error(`"${id}" is not a valid run id.`);
  }
}

export function gatherHome(): string {
  // The app only runs locally via `next start`; there is no deployment bundle for the tracer to size.
  return resolve(/*turbopackIgnore: true*/ envHome() ?? join(process.cwd(), ".gather"));
}

/** False until the first settings save, so the UI can send a new user to the setup screen. */
export async function isConfigured(): Promise<boolean> {
  const info = await stat(settingsFile()).catch(() => null);
  return info?.isFile() ?? false;
}

function runsDir(): string {
  return join(gatherHome(), "runs");
}

function settingsFile(): string {
  return join(gatherHome(), "settings.json");
}

function queueLockFile(): string {
  return join(gatherHome(), "queue.lock");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether this process may treat the runs on disk as its own. Another live process (a second server, a
 * build collecting page data) that imports the queue must not mark a running download as interrupted or
 * sweep its files, so the first process records its pid and later ones leave the records alone. A stale
 * pid (crash, reboot) is recognised by the process being gone.
 */
export async function claimQueueLock(): Promise<boolean> {
  try {
    const owner = Number((await readFile(queueLockFile(), "utf8")).trim());
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isProcessAlive(owner)) {
      return false;
    }
  } catch {
    /* no lock file yet */
  }
  await writeAtomic(queueLockFile(), `${process.pid}\n`).catch(() => {});
  return true;
}

function runFile(id: string): string {
  return join(runsDir(), `${id}.json`);
}

function logFile(id: string): string {
  return join(runsDir(), `${id}.log`);
}

function defaults(): Settings {
  return {
    galleryDlPath: envGalleryDl() ?? "C:\\tools\\gallery-dl.exe",
    mediaRoot: envMediaRoot() ?? /*turbopackIgnore: true*/ process.cwd(),
    cookies: { browser: "firefox" },
    defaultMedia: "all",
    defaultLayout: { kind: "byType" },
    historyRetention: 200,
    concurrency: 1,
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue?.message ?? "That value isn't valid.";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let tempCounter = 0;

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  tempCounter += 1;
  const temp = `${file}.${process.pid}.${tempCounter}.tmp`;
  try {
    await writeFile(temp, data, "utf8");
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

let warnedAboutSettings = false;

export async function getSettings(): Promise<Settings> {
  const fallback = defaults();
  let raw: string;
  try {
    raw = await readFile(settingsFile(), "utf8");
  } catch {
    return fallback;
  }
  try {
    const json: unknown = JSON.parse(raw);
    const parsed = settingsFileSchema.safeParse(json);
    if (!parsed.success) {
      warnAboutSettings(firstIssue(parsed.error));
    }
    // One bad field (a hand-edited concurrency, say) must not throw away the media folder and the rest.
    const saved = parsed.success ? parsed.data : salvageSettings(json);
    return {
      galleryDlPath: saved.galleryDlPath ?? fallback.galleryDlPath,
      mediaRoot: saved.mediaRoot ?? fallback.mediaRoot,
      cookies: saved.cookies ?? fallback.cookies,
      defaultMedia: saved.defaultMedia ?? fallback.defaultMedia,
      defaultLayout: saved.defaultLayout ?? fallback.defaultLayout,
      historyRetention: saved.historyRetention ?? fallback.historyRetention,
      concurrency: saved.concurrency ?? fallback.concurrency,
    };
  } catch (error) {
    warnAboutSettings(messageOf(error));
    return fallback;
  }
}

function warnAboutSettings(reason: string): void {
  if (warnedAboutSettings) return;
  warnedAboutSettings = true;
  console.warn(`gather: ignoring unreadable settings (${reason}).`);
}

function salvageSettings(json: unknown): Partial<Settings> {
  if (!isRecord(json)) return {};
  const valid: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(settingsShape.shape)) {
    const result = schema.safeParse(json[key]);
    if (result.success) valid[key] = result.data;
  }
  return settingsFileSchema.parse(valid);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new Error(firstIssue(parsed.error));
  }
  const current = await getSettings();
  const saved = parsed.data;
  const next: Settings = {
    galleryDlPath: saved.galleryDlPath ?? current.galleryDlPath,
    mediaRoot: saved.mediaRoot ?? current.mediaRoot,
    cookies: saved.cookies ?? current.cookies,
    defaultMedia: saved.defaultMedia ?? current.defaultMedia,
    defaultLayout: saved.defaultLayout ?? current.defaultLayout,
    historyRetention: saved.historyRetention ?? current.historyRetention,
    concurrency: saved.concurrency ?? current.concurrency,
  };
  const root = await stat(next.mediaRoot).catch(() => null);
  if (!root?.isDirectory()) {
    throw new Error(`The media folder ${next.mediaRoot} doesn't exist.`);
  }
  assertSafeMediaRoot(
    next.mediaRoot,
    [envAppDir(), gatherHome()].filter((dir): dir is string => dir !== undefined),
  );
  await writeAtomic(settingsFile(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounts(value: unknown): value is Counts {
  if (!isRecord(value)) return false;
  return (
    typeof value.saved === "number" &&
    typeof value.skipped === "number" &&
    typeof value.failed === "number"
  );
}

function isRunRecord(value: unknown): value is Run {
  if (!isRecord(value)) return false;
  const { id, spec, steps, status, stepIndex, counts } = value;
  if (typeof id !== "string" || !isValidRunId(id)) return false;
  if (typeof status !== "string" || !(RUN_STATUSES as readonly string[]).includes(status)) {
    return false;
  }
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex)) return false;
  if (!isCounts(counts)) return false;
  if (!isRecord(spec) || typeof spec.account !== "string") return false;
  if (!Array.isArray(steps)) return false;
  return steps.every(
    (step) =>
      isRecord(step) &&
      typeof step.label === "string" &&
      Array.isArray(step.argv) &&
      step.argv.every((arg) => typeof arg === "string"),
  );
}

export async function saveRun(run: Run): Promise<void> {
  assertRunId(run.id);
  await writeAtomic(runFile(run.id), `${JSON.stringify(run, null, 2)}\n`);
}

export async function getRun(id: string): Promise<Run | undefined> {
  if (!isValidRunId(id)) return undefined;
  let raw: string;
  try {
    raw = await readFile(runFile(id), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRunRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Ids of the stored run records, newest first. Reads the folder listing only, never a record. */
async function listRunIds(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(runsDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => isValidRunId(id))
    .sort(compareRunIds);
}

export async function listRuns(limit = 200): Promise<Run[]> {
  const ids = await listRunIds();
  // The id is the order (see compareRunIds), so reading stops once `limit` readable records are found;
  // a corrupt file in the newest window is skipped and the next one takes its place.
  const runs: Run[] = [];
  // The first batch is the whole window, so an unlimited read stays one parallel pass.
  const step = Math.max(1, Math.min(limit, ids.length));
  for (let from = 0; from < ids.length && runs.length < limit; from += step) {
    const batch = await Promise.all(ids.slice(from, from + step).map((id) => getRun(id)));
    for (const run of batch) {
      if (run && runs.length < limit) runs.push(run);
    }
  }
  return runs;
}

export async function appendLog(id: string, chunk: string): Promise<void> {
  assertRunId(id);
  if (chunk.length === 0) return;
  await mkdir(runsDir(), { recursive: true });
  await appendFile(logFile(id), chunk, "utf8");
}

export interface LogTail {
  text: string;
  /** True when older bytes were left out; `text` then starts at a line boundary. */
  truncated: boolean;
  totalBytes: number;
}

/**
 * Reads only the end of a log. A big update writes tens of thousands of lines, and History must not
 * pull that whole file into memory just to show the last screen.
 */
export async function readLogTail(id: string, maxBytes: number = LOG_TAIL_BYTES): Promise<LogTail> {
  if (!isValidRunId(id)) return { text: "", truncated: false, totalBytes: 0 };
  const limit = Math.max(0, Math.floor(maxBytes));
  let handle: FileHandle | undefined;
  try {
    handle = await open(logFile(id), "r");
    const info = await handle.stat();
    const totalBytes = info.size;
    if (totalBytes === 0) return { text: "", truncated: false, totalBytes: 0 };
    const truncated = totalBytes > limit;
    // One byte more than the cap when truncating: it tells whether the window starts on a line boundary.
    const start = truncated ? totalBytes - limit - 1 : 0;
    const length = totalBytes - start;
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const bytes = buffer.subarray(0, filled);
    if (!truncated) return { text: bytes.toString("utf8"), truncated, totalBytes };

    const startsOnLine = bytes[0] === 0x0a;
    let text = bytes.subarray(1).toString("utf8");
    if (!startsOnLine) {
      // The first line is cut in the middle; drop it rather than show half a line.
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return { text, truncated, totalBytes };
  } catch {
    return { text: "", truncated: false, totalBytes: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

let pruning: Promise<number> | undefined;

/** Every finished run calls this. Runs that end together share one pass instead of racing on the unlinks. */
export function pruneRuns(retention: number): Promise<number> {
  if (!pruning) {
    pruning = prune(retention).finally(() => {
      pruning = undefined;
    });
  }
  return pruning;
}

async function prune(retention: number): Promise<number> {
  const keep = Math.max(1, Math.floor(retention));
  // Under the limit, which is the usual case, nothing needs reading: the folder listing is enough.
  if ((await listRunIds()).length <= keep) return 0;
  const runs = await listRuns(Number.MAX_SAFE_INTEGER);
  if (runs.length <= keep) return 0;
  // A queued, running or stopping record is live state: pruning it would hide a run that is still
  // going and leave the queue writing to a file nobody lists. Active records never count as history.
  const doomed = runs.filter((run) => !isActiveStatus(run.status)).slice(keep);
  let removed = 0;
  for (const run of doomed) {
    await unlink(runFile(run.id)).catch(() => {});
    await unlink(logFile(run.id)).catch(() => {});
    removed += 1;
  }
  return removed;
}
