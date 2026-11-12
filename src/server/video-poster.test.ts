import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureVideoPoster, durationFromLog, findFfmpeg, posterArgs, resetFfmpegCache } from "@/server/video-poster";

afterEach(() => {
  delete process.env.GATHER_FFMPEG;
  delete process.env.GATHER_PACKAGED;
  resetFfmpegCache();
});

describe("findFfmpeg", () => {
  it("answers null when the binary does not exist", async () => {
    process.env.GATHER_FFMPEG = join(tmpdir(), `gather-missing-ffmpeg-${process.pid}.exe`);
    expect(await findFfmpeg()).toBeNull();
  });

  it("does not search PATH in the packaged app", async () => {
    process.env.GATHER_PACKAGED = "1";
    expect(await findFfmpeg()).toBeNull();
  });
});

describe("posterArgs", () => {
  it("seeks a little into the video and fits the frame inside 480 px", () => {
    const args = posterArgs("C:\\media\\acct\\Video\\1_1.mp4");
    expect(args[args.indexOf("-ss") + 1]).toBe("0.1");
    expect(args[args.indexOf("-threads") + 1]).toBe("1");
    const filter = args[args.indexOf("-vf") + 1];
    expect(filter).toContain("min(480,iw)");
    expect(filter).toContain("min(480,ih)");
    expect(args.at(-1)).toBe("pipe:1");
  });
});

describe("durationFromLog", () => {
  it("reads ffmpeg's duration line", () => {
    expect(durationFromLog("  Duration: 00:01:02.50, start: 0.000000, bitrate: 391 kb/s")).toBe(62.5);
    expect(durationFromLog("  Duration: 01:00:00.00, start: 0.000000")).toBe(3600);
  });

  it("answers null when there is no usable duration", () => {
    expect(durationFromLog("Duration: N/A, start: 0.000000")).toBeNull();
    expect(durationFromLog("no metadata here")).toBeNull();
  });
});

describe("captureVideoPoster", () => {
  it("answers null when the binary cannot start", async () => {
    const missing = join(tmpdir(), `gather-missing-ffmpeg-capture-${process.pid}`);
    expect(await captureVideoPoster(missing, "C:\\media\\acct\\Video\\1_1.mp4", { size: 1, mtimeMs: 1 })).toBeNull();
  });
});
