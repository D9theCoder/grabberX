import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getOfflineThumbnail,
  offlineFfmpegThumbArgs,
  offlineThumbCacheDir,
  OfflineThumbScheduler,
} from "@/server/offline/thumbs";

const fakeFfmpegScript = fileURLToPath(new URL("../__fixtures__/fake-ffmpeg.mjs", import.meta.url));
const fakeFfmpeg = { exe: process.execPath, prefixArgs: [fakeFfmpegScript] };

let sandbox = "";
let imagePath = "";
let videoPath = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-offline-thumbs-"));
  imagePath = join(sandbox, "photo_1.png");
  await sharp({ create: { width: 960, height: 480, channels: 3, background: "#4488aa" } })
    .png()
    .toFile(imagePath);
  videoPath = join(sandbox, "clip_1.mp4");
  await writeFile(videoPath, Buffer.alloc(1024, 9));
});

beforeEach(async () => {
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "home-"));
  delete process.env.FAKE_FFMPEG_LOG;
  delete process.env.FAKE_FFMPEG_DELAY_MS;
  delete process.env.FAKE_FFMPEG_FAIL;
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  delete process.env.FAKE_FFMPEG_LOG;
  delete process.env.FAKE_FFMPEG_DELAY_MS;
  delete process.env.FAKE_FFMPEG_FAIL;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe("offlineFfmpegThumbArgs", () => {
  it("encodes single-threaded 320 px libwebp to stdout", () => {
    const args = offlineFfmpegThumbArgs("C:\\media\\a\\Video\\1.mp4", "video");
    expect(args).toContain("-threads");
    expect(args[args.indexOf("-threads") + 1]).toBe("1");
    expect(args).toContain("libwebp");
    expect(args[args.indexOf("-vf") + 1]).toContain("min(320,iw)");
    expect(args.at(-1)).toBe("pipe:1");
  });
});

describe("OfflineThumbScheduler", () => {
  it("runs strictly one job at a time and deduplicates identical keys", async () => {
    const scheduler = new OfflineThumbScheduler({ isDownloadActive: () => false, pollMs: 10 });
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const makeWork = (label: string) => async () => {
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return Buffer.from(label);
    };

    const [a1, a2, b, c] = await Promise.all([
      scheduler.schedule("k1", makeWork("one")),
      scheduler.schedule("k1", makeWork("one-dup")),
      scheduler.schedule("k2", makeWork("two")),
      scheduler.schedule("k3", makeWork("three")),
    ]);

    expect(maxActive).toBe(1);
    expect(runs).toBe(3);
    expect(a1).toEqual(Buffer.from("one"));
    expect(a2).toBe(a1);
    expect(b).toEqual(Buffer.from("two"));
    expect(c).toEqual(Buffer.from("three"));
  });

  it("pauses while a gallery-dl download run is active and resumes once finished", async () => {
    let downloadRunning = true;
    const scheduler = new OfflineThumbScheduler({ isDownloadActive: () => downloadRunning, pollMs: 15 });
    let started = false;

    const pending = scheduler.schedule("paused-job", async () => {
      started = true;
      return Buffer.from("done");
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(started).toBe(false);

    downloadRunning = false;
    const result = await pending;
    expect(started).toBe(true);
    expect(result).toEqual(Buffer.from("done"));
  });
});

describe("getOfflineThumbnail", () => {
  it("builds a 320 px WebP thumbnail for images and serves subsequent calls from disk cache", async () => {
    const info = await stat(imagePath);
    const scheduler = new OfflineThumbScheduler({ isDownloadActive: () => false, pollMs: 10 });

    const first = await getOfflineThumbnail(imagePath, "image", info, { scheduler });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const meta = await sharp(first.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(160);
    expect(await readdir(offlineThumbCacheDir())).toHaveLength(1);

    // Even when a download run is active, an already-cached thumbnail serves immediately.
    const pausedScheduler = new OfflineThumbScheduler({ isDownloadActive: () => true, pollMs: 10 });
    const cached = await getOfflineThumbnail(imagePath, "image", info, {
      scheduler: pausedScheduler,
      failFastWhenPaused: true,
    });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") expect(cached.bytes).toEqual(first.bytes);
  });

  it("runs fake ffmpeg at below-normal priority for videos and caches the result once", async () => {
    const info = await stat(videoPath);
    const logPath = join(process.env.GATHER_HOME!, "ffmpeg.log");
    process.env.FAKE_FFMPEG_LOG = logPath;
    // Give the parent a brief window to lower child priority before the fake exe reads getPriority().
    process.env.FAKE_FFMPEG_DELAY_MS = "40";

    const scheduler = new OfflineThumbScheduler({ isDownloadActive: () => false, pollMs: 10 });
    const first = await getOfflineThumbnail(videoPath, "video", info, {
      scheduler,
      findFfmpegFn: async () => fakeFfmpeg,
    });
    expect(first.status).toBe("ok");

    const second = await getOfflineThumbnail(videoPath, "video", info, {
      scheduler,
      findFfmpegFn: async () => fakeFfmpeg,
    });
    expect(second.status).toBe("ok");

    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    // Invoked only once because the second call hit `.gather/offline-thumbs/`.
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { priority: number | null; args: string[] };
    expect(record.args).toContain("libwebp");
    if (record.priority !== null) {
      expect(record.priority).toBe(osConstants.priority.PRIORITY_BELOW_NORMAL);
    }
  });

  it("returns paused when failFastWhenPaused is set during an active run", async () => {
    const info = await stat(imagePath);
    const pausedScheduler = new OfflineThumbScheduler({ isDownloadActive: () => true, pollMs: 10 });
    const result = await getOfflineThumbnail(imagePath, "image", info, {
      scheduler: pausedScheduler,
      failFastWhenPaused: true,
    });
    expect(result).toEqual({ status: "paused" });
  });

  it("falls back gracefully when ffmpeg / sharp are unavailable", async () => {
    const infoImg = await stat(imagePath);
    const infoVid = await stat(videoPath);
    const scheduler = new OfflineThumbScheduler({ isDownloadActive: () => false, pollMs: 10 });

    const videoFallback = await getOfflineThumbnail(videoPath, "video", infoVid, {
      scheduler,
      findFfmpegFn: async () => null,
    });
    expect(videoFallback).toEqual({ status: "unavailable", fallback: "placeholder" });

    const imageFallback = await getOfflineThumbnail(imagePath, "image", infoImg, {
      scheduler,
      loadSharpFn: async () => null,
      findFfmpegFn: async () => null,
    });
    expect(imageFallback).toEqual({ status: "unavailable", fallback: "canvas" });
  });
});
