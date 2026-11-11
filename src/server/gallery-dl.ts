import "server-only";
import { spawn } from "node:child_process";
import { killTreeWindows } from "@/server/runner";

export interface ExeResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Runs gallery-dl once and collects what it printed. Used for --version and the update flags. */
export function runGalleryDl(exe: string, args: string[], timeoutMs: number): Promise<ExeResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: ExeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // exe is a user setting, not a project file, so it must not be traced into the build.
    const child = spawn(/*turbopackIgnore: true*/ exe, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, output, timedOut, spawnError: error.code ?? error.message });
    });
    child.on("close", (code) => finish({ code, output, timedOut }));

    const timer = setTimeout(() => {
      timedOut = true;
      // A one-file PyInstaller exe starts a second process; child.kill() would leave it running.
      if (process.platform === "win32" && child.pid !== undefined) void killTreeWindows(child.pid);
      else child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
  });
}

/** The last non-empty line, which is where gallery-dl prints the verdict of --update-check and -U. */
export function lastLine(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
