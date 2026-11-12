import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultSpec } from "@/lib/spec";
import type { Settings } from "@/lib/spec";
import { getCachedTotal, saveCachedTotal } from "@/server/store";
import { probeTotal, TOTAL_MAX_AGE_MS, totalCacheKey } from "@/server/total-probe";

const fixture = fileURLToPath(new URL("./__fixtures__/fake-gallery-dl.mjs", import.meta.url));
const probe = vi.hoisted(() => ({ mode: "probe" }));

// The real argv starts with "-j", which node would read as its own flag; the fake exe needs its script first.
vi.mock("@/lib/command", () => ({
  probeArgv: () => [fixture, `--mode=${probe.mode}`],
}));

const trackedPids: number[] = [];
let sandbox = "";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the process to change state");
}

async function setup(): Promise<{ settings: Settings; dir: string }> {
  if (sandbox === "") sandbox = await mkdtemp(join(tmpdir(), "gather-probe-"));
  const dir = await mkdtemp(join(sandbox, "case-"));
  // Each case gets its own state folder, so the count cache starts empty and never touches the real .gather.
  process.env.GATHER_HOME = join(dir, "home");
  const settings = {
    galleryDlPath: process.execPath,
    mediaRoot: dir,
    cookies: { browser: "none" },
    defaultMedia: "all",
    defaultLayout: { kind: "byType" },
  } as unknown as Settings;
  return { settings, dir };
}

const xSpec = (settings: Settings) => ({ ...createDefaultSpec(settings), account: "nasa" });

afterEach(() => {
  delete process.env.FAKE_PID_FILE;
  delete process.env.GATHER_HOME;
});

afterAll(async () => {
  for (const pid of trackedPids) {
    if (isAlive(pid)) spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, stdio: "ignore" });
  }
  // Windows releases a killed process's working folder a moment after it exits.
  if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("probeTotal", () => {
  it("reads the media count from the probe's output", async () => {
    probe.mode = "probe";
    const { settings } = await setup();
    expect(await probeTotal(xSpec(settings), settings, new AbortController().signal)).toBe(321);
  });

  it("reuses a count younger than a week instead of asking again", async () => {
    const { settings } = await setup();
    probe.mode = "probe";
    expect(await probeTotal(xSpec(settings), settings, new AbortController().signal)).toBe(321);
    // A second lookup would fail; the cached count answers instead.
    probe.mode = "fail";
    expect(await probeTotal({ ...xSpec(settings), account: "NASA" }, settings, new AbortController().signal)).toBe(321);
  });

  it("asks again once the cached count is a week old", async () => {
    const { settings } = await setup();
    await saveCachedTotal(totalCacheKey(xSpec(settings)), 99, new Date(Date.now() - TOTAL_MAX_AGE_MS - 1000));
    probe.mode = "probe";
    expect(await probeTotal(xSpec(settings), settings, new AbortController().signal)).toBe(321);
    expect((await getCachedTotal(totalCacheKey(xSpec(settings))))?.total).toBe(321);
  });

  it.skipIf(process.platform !== "win32")(
    "kills the launcher and its second process when the run stops",
    async () => {
      probe.mode = "tree";
      const { settings, dir } = await setup();
      const pidFile = join(dir, "pids.txt");
      process.env.FAKE_PID_FILE = pidFile;
      const abort = new AbortController();
      const result = probeTotal(xSpec(settings), settings, abort.signal);

      await waitFor(() => existsSync(pidFile));
      const [pid, grandchild] = (await readFile(pidFile, "utf8"))
        .trim()
        .split(" ")
        .map((value) => Number.parseInt(value, 10));
      trackedPids.push(pid!, grandchild!);
      expect(isAlive(grandchild!)).toBe(true);

      abort.abort();
      expect(await result).toBeUndefined();
      await waitFor(() => !isAlive(pid!) && !isAlive(grandchild!));
    },
  );
});
