import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@/lib/spec";
import { startProcess, sweepPartFiles } from "@/server/runner";

vi.mock("@/lib/parse-line", () => ({
  parseLine: (stream: "stdout" | "stderr", line: string): RunEvent | null => {
    if (stream === "stdout" && line.startsWith("# ")) {
      return { t: "file", kind: "skipped", path: line.slice(2) };
    }
    if (stream === "stdout" && line.startsWith("/")) return { t: "file", kind: "saved", path: line };
    if (stream === "stderr" && line.includes("[error]")) return { t: "log", level: "error", line };
    if (stream === "stderr" && line.includes("[warning]")) {
      return { t: "log", level: "warning", line };
    }
    return null;
  },
  classifyError: (line: string) => (line.includes("Not found") ? "notFound" : null),
}));

const fixture = fileURLToPath(new URL("./__fixtures__/fake-gallery-dl.mjs", import.meta.url));
const trackedPids: number[] = [];
let sandbox = "";

async function tempDir(): Promise<string> {
  if (sandbox === "") sandbox = await mkdtemp(join(tmpdir(), "gather-runner-"));
  return mkdtemp(join(sandbox, "case-"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await delay(25);
  }
  throw new Error("timed out waiting for the process to change state");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  for (const pid of trackedPids) {
    if (!isAlive(pid)) continue;
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, stdio: "ignore" });
  }
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe("startProcess", () => {
  it("streams stdout and stderr lines and resolves with the exit code", async () => {
    const dir = await tempDir();
    const events: RunEvent[] = [];
    const raw: string[] = [];
    const handle = startProcess({
      exe: process.execPath,
      argv: [fixture, "--mode=lines"],
      cwd: dir,
      onEvent: (event) => events.push(event),
      onRaw: (_stream, line) => raw.push(line),
    });

    const result = await handle.done;
    expect(result).toEqual({ exitCode: 0 });
    expect(raw).toContain("https://x.com/username/media");
    expect(raw).toContain("[twitter][warning] 1834220146_1.jpg already exists");
    expect(events).toHaveLength(3);
    expect(events).toContainEqual({
      t: "file",
      kind: "saved",
      path: "/media/username/Image/1834220145_1.jpg",
    });
    expect(events).toContainEqual({
      t: "file",
      kind: "skipped",
      path: "/media/username/Image/1834220145_2.jpg",
    });
    expect(events).toContainEqual({
      t: "log",
      level: "warning",
      line: "[twitter][warning] 1834220146_1.jpg already exists",
    });
  });

  it("reports a non-zero exit code instead of throwing", async () => {
    const dir = await tempDir();
    const handle = startProcess({
      exe: process.execPath,
      argv: [fixture, "--mode=fail"],
      cwd: dir,
      onEvent: () => {},
      onRaw: () => {},
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(1);
    expect(result.spawnError).toBeUndefined();
  });

  it("resolves with ENOENT when the exe does not exist", async () => {
    const dir = await tempDir();
    const handle = startProcess({
      exe: join(dir, "definitely-not-gallery-dl.exe"),
      argv: ["--version"],
      cwd: dir,
      onEvent: () => {},
      onRaw: () => {},
    });
    const result = await handle.done;
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBe("ENOENT");
    expect(handle.pid).toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("stop() is harmless after the process already exited", async () => {
    const dir = await tempDir();
    const handle = startProcess({
      exe: process.execPath,
      argv: [fixture, "--mode=lines"],
      cwd: dir,
      onEvent: () => {},
      onRaw: () => {},
    });
    await handle.done;
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")(
    "stop() kills the whole PyInstaller-shaped tree, not just the bootloader",
    async () => {
      const dir = await tempDir();
      const pidFile = join(dir, "pids.txt");
      trackedPids.length = 0;
      const handle = startProcess({
        exe: process.execPath,
        argv: [fixture, "--mode=tree"],
        cwd: dir,
        env: { ...process.env, FAKE_PID_FILE: pidFile },
        onEvent: () => {},
        onRaw: () => {},
      });

      await waitFor(() => existsSync(pidFile));
      const [pid, grandchild] = (await readFile(pidFile, "utf8"))
        .trim()
        .split(" ")
        .map((value) => Number.parseInt(value, 10));
      trackedPids.push(pid, grandchild);
      expect(pid).toBe(handle.pid);
      expect(isAlive(pid)).toBe(true);
      expect(isAlive(grandchild)).toBe(true);

      await handle.stop();

      await waitFor(() => !isAlive(pid) && !isAlive(grandchild));
      expect(isAlive(pid)).toBe(false);
      expect(isAlive(grandchild)).toBe(false);
    },
  );
});

describe("sweepPartFiles", () => {
  it("deletes .part and .part-* files recursively and nothing else", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "Image", "2025"), { recursive: true });
    await mkdir(join(dir, "Video"), { recursive: true });
    await writeFile(join(dir, "Image", "a.jpg.part"), "x");
    await writeFile(join(dir, "Image", "2025", "b.jpg.part-Frag12"), "x");
    await writeFile(join(dir, "Video", "c.mp4.part"), "x");
    await writeFile(join(dir, "Image", "keep.jpg"), "x");
    await writeFile(join(dir, "Video", "keep.mp4"), "x");
    await writeFile(join(dir, "archive.sqlite3"), "x");

    expect(await sweepPartFiles(dir)).toBe(3);
    expect((await readdir(dir)).sort()).toEqual(["Image", "Video", "archive.sqlite3"]);
    expect((await readdir(join(dir, "Image"))).sort()).toEqual(["2025", "keep.jpg"]);
    expect((await readdir(join(dir, "Video"))).sort()).toEqual(["keep.mp4"]);
  });

  it("is a no-op for a missing folder", async () => {
    const dir = await tempDir();
    expect(await sweepPartFiles(join(dir, "gone"))).toBe(0);
  });

  it("refuses relative paths", async () => {
    expect(await sweepPartFiles("relative")).toBe(0);
  });
});
