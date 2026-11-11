import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = require("./lib.cjs") as {
  findFreePort(): Promise<number>;
  waitForHealth(url: string, options?: Record<string, unknown>): Promise<{ ok: boolean }>;
  activeRuns(url: string): Promise<number>;
  createLog(dir: string, maxBytes?: number): { file: string; write(text: string): void; line(message: string): void };
  seedGalleryDl(seed: string, target: string): string;
  isOwnOrigin(url: string, origin: string): boolean;
};

let sandbox = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-electron-"));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("findFreePort", () => {
  it("returns a usable loopback port", async () => {
    const port = await lib.findFreePort();
    expect(port).toBeGreaterThan(1023);
    await new Promise<void>((resolve, reject) => {
      const server = createServer().listen(port, "127.0.0.1", () => server.close(() => resolve()));
      server.on("error", reject);
    });
  });
});

describe("waitForHealth", () => {
  it("resolves once the endpoint answers, even if it starts late", async () => {
    const port = await lib.findFreePort();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, activeRuns: 2 }));
    });
    setTimeout(() => server.listen(port, "127.0.0.1"), 400);
    try {
      const health = await lib.waitForHealth(`http://127.0.0.1:${port}`, { intervalMs: 50 });
      expect(health.ok).toBe(true);
      expect(await lib.activeRuns(`http://127.0.0.1:${port}`)).toBe(2);
    } finally {
      server.close();
    }
  });

  it("gives up with a clear message on timeout", async () => {
    const port = await lib.findFreePort();
    await expect(
      lib.waitForHealth(`http://127.0.0.1:${port}`, { timeoutMs: 300, intervalMs: 50 }),
    ).rejects.toThrow(/did not answer/);
  });

  it("stops early when told the server died", async () => {
    const port = await lib.findFreePort();
    await expect(
      lib.waitForHealth(`http://127.0.0.1:${port}`, { timeoutMs: 5000, shouldGiveUp: () => true }),
    ).rejects.toThrow(/stopped/);
  });
});

describe("createLog", () => {
  it("rotates to a single older file", async () => {
    const dir = join(sandbox, "logs");
    const log = lib.createLog(dir, 100);
    log.write("a".repeat(120));
    log.write("second\n");
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(["gather.1.log", "gather.log"]);
    expect(await readFile(join(dir, "gather.log"), "utf8")).toBe("second\n");
  });
});

describe("seedGalleryDl", () => {
  it("copies once and never overwrites an updated copy", async () => {
    const seed = join(sandbox, "seed.exe");
    const target = join(sandbox, "bin", "gallery-dl.exe");
    await writeFile(seed, "v1");
    expect(lib.seedGalleryDl(seed, target)).toBe("copied");
    await writeFile(target, "v2");
    expect(lib.seedGalleryDl(seed, target)).toBe("present");
    expect(await readFile(target, "utf8")).toBe("v2");
  });

  it("reports a missing seed", async () => {
    await mkdir(join(sandbox, "empty"), { recursive: true });
    expect(lib.seedGalleryDl(join(sandbox, "empty", "none.exe"), join(sandbox, "empty", "t.exe"))).toBe("no-seed");
  });
});

describe("isOwnOrigin", () => {
  it("accepts only the exact origin", () => {
    const origin = "http://127.0.0.1:4000";
    expect(lib.isOwnOrigin("http://127.0.0.1:4000/library", origin)).toBe(true);
    expect(lib.isOwnOrigin("http://127.0.0.1:4001/", origin)).toBe(false);
    expect(lib.isOwnOrigin("http://127.0.0.1:4000.evil.com/", origin)).toBe(false);
    expect(lib.isOwnOrigin("https://x.com", origin)).toBe(false);
    expect(lib.isOwnOrigin("not a url", origin)).toBe(false);
  });
});

describe("versions", () => {
  it("keeps the shell version equal to the app version", async () => {
    const root = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8"));
    const shell = JSON.parse(await readFile(join(__dirname, "package.json"), "utf8"));
    // The installer and the updater read electron/package.json; Settings shows the same number.
    expect(shell.version).toBe(root.version);
  });
});
