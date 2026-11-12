import "server-only";
import { execFile } from "node:child_process";
import { probeArgv } from "@/lib/command";
import { parseProbeTotal, totalEligible } from "@/lib/progress";
import type { JobSpec, Settings } from "@/lib/spec";

const PROBE_TIMEOUT_MS = 30_000;

export type ProbeTotal = (
  spec: JobSpec,
  settings: Settings,
  signal: AbortSignal,
) => Promise<number | undefined>;

/** Asks gallery-dl for the first item only. Any failure just means no progress bar; the run does not depend on it. */
export const probeTotal: ProbeTotal = (spec, settings, signal) => {
  if (!totalEligible(spec)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      execFile(
        settings.galleryDlPath,
        probeArgv(spec, settings),
        {
          cwd: settings.mediaRoot,
          timeout: PROBE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          signal,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        },
        (error, stdout) => resolve(error ? undefined : parseProbeTotal(stdout)),
      );
    } catch {
      resolve(undefined);
    }
  });
};
