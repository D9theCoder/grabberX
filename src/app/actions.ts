"use server";

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AccountHint, ActionResult, JobSpec, Settings } from "@/lib/spec";
import { parseJobSpec } from "@/lib/spec-schema";
import { folderNameFor, validateAccount } from "@/lib/sites";
import { getAccountHint } from "@/server/library";
import { isReserved, isValidFolderName } from "@/server/paths";
import { runQueue } from "@/server/run-queue";
import { getRun, getSettings, isValidRunId, saveSettings } from "@/server/store";

const VERSION_TIMEOUT_MS = 8000;

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
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: `gallery-dl didn't answer at ${exe}.` });
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();
  });
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
