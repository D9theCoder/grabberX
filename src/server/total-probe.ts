import "server-only";
import { probeArgv } from "@/lib/command";
import { parseProbeTotal, totalEligible } from "@/lib/progress";
import type { JobSpec, Settings } from "@/lib/spec";
import { startProcess } from "@/server/runner";
import type { ProcessHandle } from "@/server/runner";
import { getCachedTotal, saveCachedTotal } from "@/server/store";

const PROBE_TIMEOUT_MS = 30_000;
/**
 * How long a looked-up count is reused. The lookup is one more API request per run, which scheduled "update all"
 * runs would otherwise repeat for every account. An account grows slowly, and a run that outgrows the cached
 * count asks again (`refresh`).
 */
export const TOTAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface ProbeOptions {
  /** Skip the cache: the run has already passed the cached count, so the account grew. */
  refresh?: boolean;
}

export type ProbeTotal = (
  spec: JobSpec,
  settings: Settings,
  signal: AbortSignal,
  options?: ProbeOptions,
) => Promise<number | undefined>;

export function totalCacheKey(spec: Pick<JobSpec, "site" | "account">): string {
  return `${spec.site}:${spec.account.toLowerCase()}`;
}

/** The account's post count: from the cache while it is fresh, otherwise looked up and cached. */
export const probeTotal: ProbeTotal = async (spec, settings, signal, options = {}) => {
  if (!totalEligible(spec) || signal.aborted) return undefined;
  const key = totalCacheKey(spec);
  if (!options.refresh) {
    const cached = await getCachedTotal(key).catch(() => undefined);
    if (cached && Date.now() - Date.parse(cached.at) < TOTAL_MAX_AGE_MS) return cached.total;
  }
  const total = await askGalleryDl(spec, settings, signal);
  if (total !== undefined) {
    await saveCachedTotal(key, total).catch((error: unknown) => {
      console.warn("grabberX: could not cache the account's post count.", error);
    });
  }
  return total;
};

/**
 * Asks gallery-dl for the first item only. Any failure just means no progress bar; the run does not depend on it.
 * It runs through `startProcess`, so a stop or timeout ends the whole process tree the way Stop does: the one-file
 * exe is a launcher plus a second process, and killing only the launcher would leave the second one querying X.
 */
function askGalleryDl(spec: JobSpec, settings: Settings, signal: AbortSignal): Promise<number | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  const lines: string[] = [];
  let size = 0;
  let cut = false;
  let handle: ProcessHandle | undefined;
  const stop = (): void => {
    cut = true;
    void handle?.stop();
  };
  handle = startProcess({
    exe: settings.galleryDlPath,
    argv: probeArgv(spec, settings),
    cwd: settings.mediaRoot,
    onEvent: () => {},
    onRaw: (stream, line) => {
      if (stream !== "stdout" || cut) return;
      size += line.length + 1;
      if (size > MAX_OUTPUT_BYTES) {
        stop();
        return;
      }
      lines.push(line);
    },
  });
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, PROBE_TIMEOUT_MS);
  timer.unref?.();
  return handle.done.then((result) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (cut || result.exitCode !== 0) return undefined;
    return parseProbeTotal(lines.join("\n"));
  });
}
