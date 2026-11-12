import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PartWatcher } from "@/server/part-watch";

let sandbox = "";

async function tempDir(): Promise<string> {
  if (sandbox === "") sandbox = await mkdtemp(join(tmpdir(), "gather-parts-"));
  return mkdtemp(join(sandbox, "case-"));
}

afterAll(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function recorder() {
  const seeded = new Map<string, number>();
  const grown = new Map<string, number>();
  const watcher = new PartWatcher({
    seed: (key, size) => seeded.set(key, size),
    grow: (key, size) => grown.set(key, size),
  });
  return { seeded, grown, watcher };
}

/** File-system events arrive a moment after the write; poll until the expected reading shows up. */
async function pollUntil(watcher: PartWatcher, check: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    await watcher.poll();
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the watcher never reported the expected sizes");
}

describe("PartWatcher", () => {
  it("seeds what was already there and reports .part files created later", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "old.mp4.part"), Buffer.alloc(700));
    await writeFile(join(dir, "done.jpg"), Buffer.alloc(50));
    const { seeded, grown, watcher } = recorder();
    await watcher.watch(dir);
    expect([...seeded]).toEqual([["old.mp4", 700]]);

    await writeFile(join(dir, "1_1.MP4.part"), Buffer.alloc(300));
    await pollUntil(watcher, () => grown.get("1_1.mp4") === 300 || grown.get("1_1.MP4") === 300);
    await writeFile(join(dir, "1_1.MP4.part"), Buffer.alloc(900));
    await pollUntil(watcher, () => [...grown.values()].includes(900));
    expect(grown.has("done.jpg")).toBe(false);

    // Renamed to its final name: it drops out of the readings.
    await rename(join(dir, "1_1.MP4.part"), join(dir, "1_1.MP4"));
    grown.clear();
    await watcher.poll();
    expect(grown.size).toBe(1);
    expect(grown.get("old.mp4")).toBe(700);
    watcher.close();
  });

  it("counts everything in a folder that appears after watching began, and adds up fragments", async () => {
    const root = await tempDir();
    const dir = join(root, "w1");
    const { seeded, grown, watcher } = recorder();
    await watcher.watch(dir);
    await mkdir(dir);
    await writeFile(join(dir, "2_1.mp4.part-Frag1"), Buffer.alloc(100));
    await writeFile(join(dir, "2_1.mp4.part-Frag2"), Buffer.alloc(150));
    await pollUntil(watcher, () => grown.get("2_1.mp4") === 250);
    expect(seeded.size).toBe(0);
    watcher.close();
  });

  it("reports nothing once closed", async () => {
    const dir = await tempDir();
    const { grown, watcher } = recorder();
    await watcher.watch(dir);
    watcher.close();
    await writeFile(join(dir, "3_1.mp4.part"), Buffer.alloc(10));
    await watcher.poll();
    expect(grown.size).toBe(0);
  });
});
