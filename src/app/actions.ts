"use server";

import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AccountHint, ActionResult, JobSpec, Settings, SiteId } from "@/lib/spec";
import { classifyCookieCheck } from "@/lib/cookie-check";
import type { CookieCheckKind } from "@/lib/cookie-check";
import { parseJobSpec } from "@/lib/spec-schema";
import { folderNameFor, siteDef, validateAccount } from "@/lib/sites";
import { lastLine, runGalleryDl } from "@/server/gallery-dl";
import { getAccountHint } from "@/server/library";
import { isReserved, isValidFolderName } from "@/server/paths";
import { runQueue } from "@/server/run-queue";
import { killTreeWindows } from "@/server/runner";
import { getRun, getSettings, isValidRunId, saveSettings } from "@/server/store";

const VERSION_TIMEOUT_MS = 8000;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 180_000;
const COOKIE_CHECK_TIMEOUT_MS = 20_000;

/** The probe account does not have to exist: a signed-out session fails before any lookup. */
const PROBE_ACCOUNT = "example_user";

const hintInput = z.object({
  site: z.enum(["x", "instagram", "bluesky", "pixiv", "reddit", "url"]),
  account: z.string(),
  folder: z.string().optional(),
});

function folderProblem(folder: string): string | null {
  if (!isValidFolderName(folder)) {
    return "Folder names can use letters, numbers, dots, dashes and underscores, up to 64 characters.";
  }
  if (isReserved(folder)) {
    return `"${folder}" is used by the app itself. Choose a different folder name in Advanced → Folder name.`;
  }
  return null;
}

/** Our validation messages are safe to show; fs errors mention paths and get a plain line. */
function settingsError(error: unknown): string {
  if (error instanceof Error && !("code" in error)) return error.message;
  return "Those settings couldn't be saved.";
}

export async function startRun(
  input: unknown,
): Promise<ActionResult<{ runId: string; position: number }>> {
  const parsed = parseJobSpec(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const validated = validateAccount(parsed.data.site, parsed.data.account);
  if (!validated.ok) return { ok: false, error: validated.message };
  const spec: JobSpec = { ...parsed.data, account: validated.account };

  let folder: string;
  try {
    folder = folderNameFor(spec);
  } catch {
    return {
      ok: false,
      error: "That account can't be used as a folder name. Pick one in Advanced → Folder name.",
    };
  }
  const problem = folderProblem(folder);
  if (problem) return { ok: false, error: problem };

  try {
    const run = await runQueue.enqueue(spec);
    revalidatePath("/history");
    revalidatePath("/library");
    return { ok: true, data: { runId: run.id, position: runQueue.queuePosition(run.id) } };
  } catch (error) {
    console.error("gather: could not start the run.", error);
    return { ok: false, error: "The run couldn't be started." };
  }
}

export async function stopRun(id: string): Promise<ActionResult<null>> {
  if (typeof id !== "string" || !isValidRunId(id)) {
    return { ok: false, error: "That run doesn't exist." };
  }
  try {
    const stopped = await runQueue.stop(id);
    if (!stopped) return { ok: false, error: "That run is no longer active." };
    revalidatePath("/history");
    return { ok: true, data: null };
  } catch (error) {
    console.error("gather: could not stop the run.", error);
    return { ok: false, error: "The run couldn't be stopped." };
  }
}

export async function saveSettingsAction(patch: unknown): Promise<ActionResult<Settings>> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { ok: false, error: "Those settings aren't valid." };
  }
  try {
    const settings = await saveSettings(patch as Partial<Settings>);
    await runQueue.resume().catch((error: unknown) => {
      console.error("gather: could not start queued runs after saving the settings.", error);
    });
    revalidatePath("/");
    revalidatePath("/library");
    revalidatePath("/settings");
    return { ok: true, data: settings };
  } catch (error) {
    console.error("gather: could not save the settings.", error);
    return { ok: false, error: settingsError(error) };
  }
}

export async function checkGalleryDl(path?: string): Promise<ActionResult<{ version: string }>> {
  const settings = await getSettings().catch(() => undefined);
  const exe = path?.trim() || settings?.galleryDlPath || "";
  if (exe === "") return { ok: false, error: "Enter the path to gallery-dl." };

  return new Promise<ActionResult<{ version: string }>>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ActionResult<{ version: string }>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      // exe is a user setting, not a project file, so it must not be traced into the build.
      child = spawn(/*turbopackIgnore: true*/ exe, ["--version"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      console.error("gather: could not run gallery-dl --version.", error);
      resolve({ ok: false, error: `gallery-dl wasn't found at ${exe}.` });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT";
      finish({
        ok: false,
        error: missing
          ? `gallery-dl wasn't found at ${exe}.`
          : `gallery-dl couldn't be started at ${exe}.`,
      });
    });
    child.on("close", (code) => {
      const version = (stdout.trim() || stderr.trim()).split(/\r?\n/)[0]?.trim() ?? "";
      if (code === 0 && version !== "") {
        finish({ ok: true, data: { version } });
        return;
      }
      if (code === 0) {
        finish({ ok: true, data: { version: "unknown" } });
        return;
      }
      finish({ ok: false, error: `gallery-dl at ${exe} didn't answer.` });
    });

    timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid !== undefined) {
        // A one-file PyInstaller exe starts a second process; child.kill() would leave it running.
        void killTreeWindows(child.pid);
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      finish({ ok: false, error: `gallery-dl didn't answer at ${exe}.` });
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();
  });
}

const cookieCheckInput = z.object({
  site: z.enum(["x", "instagram", "bluesky", "pixiv", "reddit", "url"]).optional(),
  account: z.string().optional(),
});

/**
 * A cheap, read-only probe: one simulated file against the account's page. gallery-dl has to read
 * the browser cookies and authenticate before it lists anything, so its exit code and the lines it
 * printed say whether the session works. Nothing blocks the run; the answer is only a hint.
 */
export async function checkCookies(
  input?: unknown,
): Promise<ActionResult<{ kind: CookieCheckKind }>> {
  const parsed = cookieCheckInput.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: "That check isn't valid." };
  const settings = await getSettings().catch(() => undefined);
  if (!settings) return { ok: false, error: "Those settings couldn't be read." };
  if (settings.cookies.browser === "none") return { ok: true, data: { kind: "skipped" } };

  const site: SiteId = parsed.data.site ?? "x";
  const accountInput = parsed.data.account?.trim() ?? "";
  const validated = accountInput ? validateAccount(site, accountInput) : null;
  const probeUrl = validated?.ok
    ? siteDef(site).urlFor(validated.account)
    : `https://x.com/${PROBE_ACCOUNT}/media`;

  const browser = settings.cookies.browser;
  const profile = settings.cookies.profile?.trim();
  const result = await runGalleryDl(
    settings.galleryDlPath,
    [
      "--simulate",
      "--range",
      "1",
      "--no-colors",
      "--cookies-from-browser",
      profile ? `${browser}:${profile}` : browser,
      probeUrl,
    ],
    COOKIE_CHECK_TIMEOUT_MS,
  );
  // The output can name the user's profile path, so only the classification leaves this function.
  return { ok: true, data: { kind: classifyCookieCheck(result) } };
}

export async function accountHint(input: unknown): Promise<AccountHint> {
  const parsed = hintInput.safeParse(input);
  if (!parsed.success) return { kind: "empty" };
  try {
    return await getAccountHint({
      site: parsed.data.site,
      account: parsed.data.account,
      folder: parsed.data.folder,
    });
  } catch (error) {
    console.error("gather: could not inspect the account.", error);
    return { kind: "empty" };
  }
}

export async function runAgain(
  id: string,
): Promise<ActionResult<{ runId: string; position: number }>> {
  if (typeof id !== "string" || !isValidRunId(id)) {
    return { ok: false, error: "That run doesn't exist." };
  }
  const previous = await getRun(id);
  if (!previous) return { ok: false, error: "That run isn't in history any more." };
  return startRun(previous.spec);
}

const setupInput = z.object({
  mediaRoot: z.string().trim().min(1, "Choose a folder for your downloads."),
  browser: z.enum(["firefox", "chrome", "edge", "none"], "Pick a browser."),
});

/** The first-run screen: creates the library folder and writes the first settings file. */
export async function completeSetup(input: unknown): Promise<ActionResult<Settings>> {
  const parsed = setupInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Those settings aren't valid." };
  }
  try {
    await mkdir(parsed.data.mediaRoot, { recursive: true });
    const settings = await saveSettings({
      mediaRoot: parsed.data.mediaRoot,
      cookies: { browser: parsed.data.browser },
    });
    revalidatePath("/", "layout");
    return { ok: true, data: settings };
  } catch (error) {
    console.error("gather: could not finish the setup.", error);
    return { ok: false, error: settingsError(error) };
  }
}

export async function checkGalleryDlUpdate(): Promise<ActionResult<{ upToDate: boolean; message: string }>> {
  const settings = await getSettings();
  const result = await runGalleryDl(settings.galleryDlPath, ["--update-check"], UPDATE_CHECK_TIMEOUT_MS);
  if (result.spawnError) return { ok: false, error: `gallery-dl wasn't found at ${settings.galleryDlPath}.` };
  if (result.timedOut) return { ok: false, error: "The update check timed out. Check your connection." };
  const message = lastLine(result.output);
  if (result.code !== 0 && message === "") return { ok: false, error: "The update check failed." };
  return { ok: true, data: { upToDate: /up to date/i.test(message), message } };
}

export async function updateGalleryDl(): Promise<ActionResult<{ version: string }>> {
  if (runQueue.list().length > 0) {
    return { ok: false, error: "A download is running. Update gallery-dl when it has finished." };
  }
  const settings = await getSettings();
  const result = await runGalleryDl(settings.galleryDlPath, ["--update"], UPDATE_TIMEOUT_MS);
  if (result.spawnError) return { ok: false, error: `gallery-dl wasn't found at ${settings.galleryDlPath}.` };
  if (result.timedOut) return { ok: false, error: "The update timed out. Check your connection." };
  if (result.code !== 0) return { ok: false, error: lastLine(result.output) || "The update failed." };
  const version = await checkGalleryDl(settings.galleryDlPath);
  revalidatePath("/settings");
  return version.ok ? { ok: true, data: { version: version.data.version } } : version;
}
