import "server-only";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Counts, Run, Settings } from "@/lib/spec";

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

const RUN_ID = /^[0-9A-Za-z_.:-]{1,160}$/;

export function isValidRunId(id: string): boolean {
  if (!RUN_ID.test(id)) return false;
  return !id.includes("..");
}

function assertRunId(id: string): void {
  if (!isValidRunId(id)) {
    throw new Error(`"${id}" is not a valid run id.`);
  }
}

function gatherHome(): string {
  // The app only runs locally via `next start`; there is no deployment bundle for the tracer to size.
  return resolve(/*turbopackIgnore: true*/ process.env.GATHER_HOME ?? join(process.cwd(), ".gather"));
}

function runsDir(): string {
  return join(gatherHome(), "runs");
}

function settingsFile(): string {
  return join(gatherHome(), "settings.json");
}

function runFile(id: string): string {
  return join(runsDir(), `${id}.json`);
}

function logFile(id: string): string {
  return join(runsDir(), `${id}.log`);
}

function defaults(): Settings {
  return {
    galleryDlPath: "C:\\tools\\gallery-dl.exe",
    mediaRoot: process.cwd(),
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
    const parsed = settingsFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(firstIssue(parsed.error));
    }
    const saved = parsed.data;
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
    if (!warnedAboutSettings) {
      warnedAboutSettings = true;
      console.warn(`gather: ignoring unreadable settings file (${messageOf(error)}).`);
    }
    return fallback;
  }
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

function sortKey(run: Run): string {
  return run.startedAt ?? run.id;
}

export async function listRuns(limit = 200): Promise<Run[]> {
  let names: string[];
  try {
    names = await readdir(runsDir());
  } catch {
    return [];
  }
  const ids = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => isValidRunId(id));
  const loaded = await Promise.all(ids.map((id) => getRun(id)));
  const runs = loaded.filter((run): run is Run => run !== undefined);
  runs.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  return typeof limit === "number" && runs.length > limit ? runs.slice(0, limit) : runs;
}

export async function appendLog(id: string, chunk: string): Promise<void> {
  assertRunId(id);
  if (chunk.length === 0) return;
  await mkdir(runsDir(), { recursive: true });
  await appendFile(logFile(id), chunk, "utf8");
}

export async function readLog(id: string): Promise<string> {
  if (!isValidRunId(id)) return "";
  try {
    return await readFile(logFile(id), "utf8");
  } catch {
    return "";
  }
}

export async function pruneRuns(retention: number): Promise<number> {
  const keep = Math.max(1, Math.floor(retention));
  const runs = await listRuns(Number.MAX_SAFE_INTEGER);
  if (runs.length <= keep) return 0;
  const doomed = runs.slice(keep);
  let removed = 0;
  for (const run of doomed) {
    await unlink(runFile(run.id)).catch(() => {});
    await unlink(logFile(run.id)).catch(() => {});
    removed += 1;
  }
  return removed;
}
