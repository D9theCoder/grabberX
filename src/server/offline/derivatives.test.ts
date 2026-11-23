import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OFFLINE_IMAGE_SETTINGS,
  DEFAULT_OFFLINE_SETTINGS,
  DEFAULT_OFFLINE_VIDEO_SETTINGS,
} from "@/lib/offline";
import {
  fitImageToOfflineLimits,
  OfflineDerivativeScheduler,
  offlineDerivativeKey,
  pruneOfflineFilesCache,
  resetOfflineDerivativeState,
  transcodeVideoToFile,
} from "@/server/offline/derivatives";
import {
  buildVideoTranscodeArgs,
  parseEncodersList,
  probeVideoEncoders,
  resetEncoderCache,
  selectVideoEncoder,
} from "@/server/offline/encoder";
import { parseBatteryStatusOutput } from "@/server/offline/power";

const fakeFfmpegScript = fileURLToPath(new URL("../__fixtures__/fake-ffmpeg.mjs", import.meta.url));
const fakeFfmpeg = { exe: process.execPath, prefixArgs: [fakeFfmpegScript] };

let sandbox = "";
let smallPngPath = "";
let smallPngBytes: Buffer;
let largeSolidPath = "";
let noisyImagePath = "";
let videoPath = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-offline-deriv-"));

  // 1. Small compliant PNG (already under maxEdge and maxKB) -> passthrough candidate.
  smallPngPath = join(sandbox, "small.png");
  smallPngBytes = await sharp({
    create: { width: 300, height: 200, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  await writeFile(smallPngPath, smallPngBytes);

  // 2. Oversized dimensions image (3200x1600) -> needs resize down to maxEdge without upscaling.
  largeSolidPath = join(sandbox, "large.png");
  await sharp({
    create: { width: 3200, height: 1600, channels: 3, background: "#557799" },
  })
    .png()
    .toFile(largeSolidPath);

  // 3. High-entropy noisy image (1000x1000 random RGB) -> exceeds tight maxKB so quality + dimension stepping runs.
  noisyImagePath = join(sandbox, "noisy.png");
  const noise = randomBytes(1000 * 1000 * 3);
  await sharp(noise, { raw: { width: 1000, height: 1000, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toFile(noisyImagePath);

  // 4. Synthetic video file for fake-ffmpeg tests.
  videoPath = join(sandbox, "clip.mp4");
  await writeFile(videoPath, Buffer.alloc(4096, 5));
});

beforeEach(async () => {
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "home-"));
  resetOfflineDerivativeState();
  resetEncoderCache();
  delete process.env.FAKE_FFMPEG_LOG;
  delete process.env.FAKE_FFMPEG_DELAY_MS;
  delete process.env.FAKE_FFMPEG_FAIL;
  delete process.env.FAKE_FFMPEG_ENCODERS;
  delete process.env.FAKE_FFMPEG_WORKING_ENCODERS;
  delete process.env.FAKE_FFMPEG_FAIL_CODECS;
});

afterAll(async () => {
  resetOfflineDerivativeState();
  resetEncoderCache();
  delete process.env.GATHER_HOME;
  delete process.env.FAKE_FFMPEG_LOG;
  delete process.env.FAKE_FFMPEG_DELAY_MS;
  delete process.env.FAKE_FFMPEG_FAIL;
  delete process.env.FAKE_FFMPEG_ENCODERS;
  delete process.env.FAKE_FFMPEG_WORKING_ENCODERS;
  delete process.env.FAKE_FFMPEG_FAIL_CODECS;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe("fitImageToOfflineLimits", () => {
  it("serves images already within limits and in an accepted format as-is without re-encoding", async () => {
    const info = await stat(smallPngPath);
    const result = await fitImageToOfflineLimits(smallPngPath, info.size, {
      ...DEFAULT_OFFLINE_IMAGE_SETTINGS,
      maxEdge: 2048,
      maxKB: 512,
      format: "webp",
    });
    expect(result).not.toBeNull();
    expect(result!.passthrough).toBe(true);
    expect(result!.contentType).toBe("image/png");
    expect(result!.bytes.equals(smallPngBytes)).toBe(true);
  });

  it("resizes oversized images to longest edge <= maxEdge in the configured format", async () => {
    const info = await stat(largeSolidPath);
    const result = await fitImageToOfflineLimits(largeSolidPath, info.size, {
      ...DEFAULT_OFFLINE_IMAGE_SETTINGS,
      maxEdge: 1280,
      maxKB: 512,
      format: "jpeg",
      quality: 80,
    });
    expect(result).not.toBeNull();
    expect(result!.passthrough).toBe(false);
    expect(result!.contentType).toBe("image/jpeg");
    expect(result!.ext).toBe("jpg");
    const meta = await sharp(result!.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(640);
  });

  it("steps quality down and then shrinks dimensions by 15% steps to fit a noisy image under maxKB", async () => {
    const info = await stat(noisyImagePath);
    const result = await fitImageToOfflineLimits(noisyImagePath, info.size, {
      ...DEFAULT_OFFLINE_IMAGE_SETTINGS,
      maxEdge: 2048,
      maxKB: 128,
      format: "webp",
      quality: 85,
    });
    expect(result).not.toBeNull();
    expect(result!.passthrough).toBe(false);
    expect(result!.contentType).toBe("image/webp");
    expect(result!.bytes.length).toBeLessThanOrEqual(128 * 1024);
    expect(result!.qualityUsed).toBe(40);
    const meta = await sharp(result!.bytes).metadata();
    expect(meta.format).toBe("webp");
    // Dimension stepping reduced it below original 1000 px to fit within 128 KB.
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThan(1000);
  });
});

describe("video encoder detection and transcode arguments", () => {
  it("parses ffmpeg -encoders output", () => {
    const sample = [
      "Encoders:",
      " V..... h264_nvenc           NVIDIA NVENC H.264 encoder",
      " V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration)",
      " V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
    ].join("\n");
    expect(parseEncodersList(sample)).toEqual(["h264_nvenc", "h264_qsv", "libx264"]);
  });

  it("prefers NVENC -> QSV -> AMF -> libx264 and verifies GPU encoders with a tiny test encode", async () => {
    // 1. NVENC listed & working -> chooses h264_nvenc.
    process.env.FAKE_FFMPEG_ENCODERS = "h264_nvenc,h264_qsv,h264_amf,libx264";
    process.env.FAKE_FFMPEG_WORKING_ENCODERS = "h264_nvenc,h264_qsv";
    const nvencProbe = await probeVideoEncoders(fakeFfmpeg);
    expect(nvencProbe.bestGpu).toBe("h264_nvenc");
    expect(selectVideoEncoder("auto", nvencProbe)).toMatchObject({
      codec: "h264_nvenc",
      label: "Using NVIDIA GPU (h264_nvenc)",
    });
    expect(selectVideoEncoder("cpu", nvencProbe)).toMatchObject({
      codec: "libx264",
      label: "Using CPU (libx264)",
    });

    // 2. NVENC fails tiny encode, QSV succeeds -> chooses h264_qsv.
    process.env.FAKE_FFMPEG_WORKING_ENCODERS = "h264_qsv";
    const qsvProbe = await probeVideoEncoders(fakeFfmpeg);
    expect(qsvProbe.bestGpu).toBe("h264_qsv");
    expect(selectVideoEncoder("auto", qsvProbe)).toMatchObject({
      codec: "h264_qsv",
      label: "Using Intel GPU (h264_qsv)",
    });

    // 3. All GPU encoders fail tiny encode -> falls back to libx264.
    process.env.FAKE_FFMPEG_WORKING_ENCODERS = "";
    const cpuOnly = await probeVideoEncoders(fakeFfmpeg);
    expect(cpuOnly.bestGpu).toBeNull();
    expect(cpuOnly.hasCpu).toBe(true);
    expect(selectVideoEncoder("auto", cpuOnly)).toMatchObject({
      codec: "libx264",
      label: "Using CPU (libx264)",
    });
    expect(selectVideoEncoder("gpu", cpuOnly)).toMatchObject({
      codec: "libx264",
      fallback: true,
    });

    // 4. No ffmpeg -> unavailable.
    const none = await probeVideoEncoders(null);
    expect(selectVideoEncoder("auto", none)).toMatchObject({
      ffmpegAvailable: false,
      codec: null,
      label: "ffmpeg not found — videos can't be saved offline",
    });
  });

  it("builds H.264 + AAC faststart MP4 args without upscaling and respects audio drop & cpuThreads", () => {
    const keepArgs = buildVideoTranscodeArgs(
      "in.mp4",
      "out.mp4",
      { ...DEFAULT_OFFLINE_VIDEO_SETTINGS, maxHeight: 720, bitrateKbps: 1200, audio: "keep", audioKbps: 96, cpuThreads: 3 },
      "libx264",
    );
    expect(keepArgs).toContain("libx264");
    expect(keepArgs).toContain("veryfast");
    expect(keepArgs[keepArgs.indexOf("-threads") + 1]).toBe("3");
    expect(keepArgs[keepArgs.indexOf("-vf") + 1]).toContain("scale=-2:");
    expect(keepArgs[keepArgs.indexOf("-vf") + 1]).toContain("min(720,ih)");
    expect(keepArgs).toContain("aac");
    expect(keepArgs[keepArgs.indexOf("-b:a") + 1]).toBe("96k");
    expect(keepArgs).toContain("+faststart");

    const dropArgs = buildVideoTranscodeArgs(
      "in.mp4",
      "out.mp4",
      { ...DEFAULT_OFFLINE_VIDEO_SETTINGS, maxHeight: 480, audio: "drop" },
      "h264_nvenc",
    );
    expect(dropArgs).toContain("h264_nvenc");
    expect(dropArgs).toContain("-an");
    expect(dropArgs).not.toContain("aac");
    expect(dropArgs).toContain("+faststart");
  });

  it("falls back to libx264 when a GPU transcode fails at runtime under auto mode, leaving no temp files", async () => {
    process.env.FAKE_FFMPEG_ENCODERS = "h264_nvenc,libx264";
    process.env.FAKE_FFMPEG_WORKING_ENCODERS = "h264_nvenc";
    process.env.FAKE_FFMPEG_FAIL_CODECS = "h264_nvenc";
    const logPath = join(process.env.GATHER_HOME!, "ffmpeg-video.log");
    process.env.FAKE_FFMPEG_LOG = logPath;

    const outDir = join(process.env.GATHER_HOME!, "offline-files");
    await mkdir(outDir, { recursive: true });
    const target = join(outDir, "testvideo.mp4");

    const ok = await transcodeVideoToFile(
      videoPath,
      target,
      { ...DEFAULT_OFFLINE_VIDEO_SETTINGS, enabled: true, encoder: "auto" },
      { detectEncodersFn: () => probeVideoEncoders(fakeFfmpeg) },
    );
    expect(ok).toBe(true);
    const files = await readdir(outDir);
    expect(files).toEqual(["testvideo.mp4"]);

    const logLines = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    const mp4Calls = logLines.filter((entry) => entry.args.includes("mp4"));
    expect(mp4Calls).toHaveLength(2);
    expect(mp4Calls[0]!.args).toContain("h264_nvenc");
    expect(mp4Calls[1]!.args).toContain("libx264");
  });
});

describe("power status parser", () => {
  it("treats empty output (desktop without battery), AC, and charging as plugged in; discharging as battery", () => {
    expect(parseBatteryStatusOutput("")).toBe(true);
    expect(parseBatteryStatusOutput("   \r\n")).toBe(true);
    expect(parseBatteryStatusOutput("1")).toBe(false);
    expect(parseBatteryStatusOutput("4")).toBe(false);
    expect(parseBatteryStatusOutput("5")).toBe(false);
    expect(parseBatteryStatusOutput("2")).toBe(true);
    expect(parseBatteryStatusOutput("3")).toBe(true);
    expect(parseBatteryStatusOutput("6")).toBe(true);
    expect(parseBatteryStatusOutput("1,6")).toBe(true);
  });
});

describe("OfflineDerivativeScheduler throttling & priority", () => {
  it("pauses while a download is active or while on battery (when onlyWhenPluggedIn=true)", async () => {
    let downloadActive = true;
    let pluggedIn = false;
    const cacheDir = join(process.env.GATHER_HOME!, "offline-files");
    const scheduler = new OfflineDerivativeScheduler({
      isDownloadActive: () => downloadActive,
      isPluggedIn: async () => pluggedIn,
      pollMs: 15,
      getCacheDir: () => cacheDir,
    });

    const info = await stat(smallPngPath);
    const job = {
      key: offlineDerivativeKey("a", "Image/small.png", "v1", "p1"),
      account: "a",
      relPath: "Image/small.png",
      fullPath: smallPngPath,
      kind: "image" as const,
      size: info.size,
      mtimeMs: info.mtimeMs,
      v: "v1",
      settings: { ...DEFAULT_OFFLINE_SETTINGS, enabled: true, onlyWhenPluggedIn: true },
    };

    expect(await scheduler.getPauseReason(true)).toBe("download");
    const pending = scheduler.enqueue(job, { priority: true });

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(scheduler.activeJobs).toBe(0);

    // Download ends, but still on battery -> stays paused.
    downloadActive = false;
    expect(await scheduler.getPauseReason(true)).toBe("battery");
    expect(await scheduler.getPauseReason(false)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(scheduler.activeJobs).toBe(0);

    // Plug in -> job runs and finishes.
    pluggedIn = true;
    const result = await pending;
    expect(result).not.toBeNull();
    expect(result!.ext).toBe("png");
  });

  it("runs priority jobs ahead of background jobs with concurrency 1", async () => {
    const cacheDir = join(process.env.GATHER_HOME!, "offline-files");
    const order: string[] = [];
    const scheduler = new OfflineDerivativeScheduler({
      isDownloadActive: () => false,
      isPluggedIn: async () => true,
      pollMs: 10,
      getCacheDir: () => cacheDir,
      onDerivativeWritten: () => {},
    });

    const info = await stat(smallPngPath);
    const mkJob = (label: string) => ({
      key: label,
      account: "a",
      relPath: `${label}.png`,
      fullPath: smallPngPath,
      kind: "image" as const,
      size: info.size,
      mtimeMs: info.mtimeMs,
      v: label,
      settings: { ...DEFAULT_OFFLINE_SETTINGS, enabled: true },
    });

    const p1 = scheduler.enqueue(mkJob("bg-1"), { priority: false }).then((r) => {
      order.push("bg-1");
      return r;
    });
    const p2 = scheduler.enqueue(mkJob("bg-2"), { priority: false }).then((r) => {
      order.push("bg-2");
      return r;
    });
    const p3 = scheduler.enqueue(mkJob("prio-1"), { priority: true }).then((r) => {
      order.push("prio-1");
      return r;
    });

    await Promise.all([p1, p2, p3]);
    // bg-1 started immediately; prio-1 jumped ahead of bg-2.
    expect(order[0]).toBe("bg-1");
    expect(order[1]).toBe("prio-1");
    expect(order[2]).toBe("bg-2");
  });
});

describe("pruneOfflineFilesCache LRU eviction", () => {
  it("evicts oldest-mtime files first until total cache fits within limitBytes", async () => {
    const dir = join(process.env.GATHER_HOME!, "offline-files");
    await mkdir(dir, { recursive: true });

    const files = [
      { name: "aaa.webp", size: 1000, ageSec: 300 },
      { name: "bbb.webp", size: 1000, ageSec: 200 },
      { name: "ccc.webp", size: 1000, ageSec: 100 },
      { name: "ddd.webp", size: 1000, ageSec: 10 },
    ];
    const now = Date.now();
    for (const item of files) {
      const p = join(dir, item.name);
      await writeFile(p, Buffer.alloc(item.size, 1));
      const t = new Date(now - item.ageSec * 1000);
      await utimes(p, t, t);
    }

    const res = await pruneOfflineFilesCache(2200, dir);
    expect(res.evicted).toBe(2);
    expect(res.remainingBytes).toBe(2000);
    expect((await readdir(dir)).sort()).toEqual(["ccc.webp", "ddd.webp"]);
  });
});
