import "server-only";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { envFfmpeg, isPackaged } from "@/server/env";
import { savePoster } from "@/server/thumbs";

/**
 * ffmpeg is optional. From source it is looked up on PATH; the packaged app uses only `GATHER_FFMPEG`, so it
 * never runs an arbitrary PATH binary. Without it, the first desktop tile still captures a poster in the
 * browser. The phone never uploads one.
 */

const DETECT_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024;
const DURATION = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

let detected: Promise<string | null> | null = null;

/** Windows' Chocolatey shim spawns the real ffmpeg, so killing only the shim can leave the decoder running. */
function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  killer.on("error", () => child.kill());
}

export function findFfmpeg(): Promise<string | null> {
  if (detected !== null) return detected;
  const override = envFfmpeg();
  if (override === undefined && isPackaged()) {
    detected = Promise.resolve(null);
    return detected;
  }
  const binary = override ?? "ffmpeg";
  detected = new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(/*turbopackIgnore: true*/ binary, ["-version"], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, DETECT_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? binary : null));
  });
  return detected;
}

/** For tests: forget the cached ffmpeg lookup. */
export function resetFfmpegCache(): void {
  detected = null;
}

/** One frame at most 480 px on its longer side, as PNG, so `savePoster` can validate and re-encode it. */
export function posterArgs(fullPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "info",
    "-nostats",
    "-nostdin",
    "-ss",
    "0.1",
    "-threads",
    "1",
    "-i",
    fullPath,
    "-frames:v",
    "1",
    "-an",
    "-vf",
    "scale=w='min(480,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease",
    "-pix_fmt",
    "rgb24",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "pipe:1",
  ];
}

/** Reads the input's length from ffmpeg's `Duration: HH:MM:SS.ss` log line. */
export function durationFromLog(text: string): number | null {
  const match = DURATION.exec(text);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export interface VideoPoster {
  bytes: number;
  seconds: number | null;
}

/** Captures one frame, stores the 480 px poster, and reports the length when ffmpeg logged it. */
export async function captureVideoPoster(
  binary: string,
  fullPath: string,
  file: { size: number; mtimeMs: number },
): Promise<VideoPoster | null> {
  const frame = await readFrame(binary, fullPath);
  if (frame === null) return null;
  const stored = await savePoster(fullPath, file, frame.png, "idle");
  return stored === null ? null : { bytes: stored, seconds: frame.seconds };
}

function readFrame(binary: string, fullPath: string): Promise<{ png: Buffer; seconds: number | null } | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { png: Buffer; seconds: number | null } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(/*turbopackIgnore: true*/ binary, posterArgs(fullPath), {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }
    const chunks: Buffer[] = [];
    const log: Buffer[] = [];
    let size = 0;
    let logSize = 0;
    timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, CAPTURE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        killTree(child);
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (logSize >= MAX_LOG_BYTES) return;
      logSize += chunk.length;
      log.push(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        finish(null);
        return;
      }
      finish({ png: Buffer.concat(chunks), seconds: durationFromLog(Buffer.concat(log).toString("utf8")) });
    });
  });
}
