import "server-only";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type {
  OfflineEncoderStatus,
  OfflineVideoEncoder,
  OfflineVideoSettings,
  VideoCodecName,
} from "@/lib/offline";
import type { FfmpegCommand } from "@/server/offline/thumbs";
import { findFfmpeg } from "@/server/video-poster";

const LIST_TIMEOUT_MS = 5_000;
const TEST_ENCODE_TIMEOUT_MS = 8_000;
const GPU_CANDIDATES: readonly Exclude<VideoCodecName, "libx264">[] = [
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
];

export interface EncoderDetectionResult {
  ffmpegAvailable: boolean;
  command: FfmpegCommand | null;
  listed: VideoCodecName[];
  verifiedGpus: Exclude<VideoCodecName, "libx264">[];
  bestGpu: Exclude<VideoCodecName, "libx264"> | null;
  hasCpu: boolean;
}

interface EncoderCacheState {
  promise: Promise<EncoderDetectionResult> | null;
}

const ENCODER_CACHE_KEY = Symbol.for("gather.offline.encoders");

function encoderState(): EncoderCacheState {
  const holder = globalThis as unknown as Record<symbol, EncoderCacheState | undefined>;
  return (holder[ENCODER_CACHE_KEY] ??= { promise: null });
}

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

function runFfmpegCommand(
  command: FfmpegCommand,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { ok: boolean; stdout: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const exe = typeof command === "string" ? command : command.exe;
    const fullArgs = [...(typeof command === "string" ? [] : command.prefixArgs), ...args];

    let child: ChildProcess;
    try {
      child = spawn(/*turbopackIgnore: true*/ exe, fullArgs, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish({ ok: false, stdout: "" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, stdout: "" });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (size < 512 * 1024) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    child.on("error", () => finish({ ok: false, stdout: "" }));
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/** Extracts supported H.264 encoder names from `ffmpeg -hide_banner -encoders` output. */
export function parseEncodersList(stdout: string): VideoCodecName[] {
  const found: VideoCodecName[] = [];
  for (const name of [...GPU_CANDIDATES, "libx264"] as const) {
    if (new RegExp(`\\b${name}\\b`).test(stdout)) {
      found.push(name);
    }
  }
  return found;
}

async function verifyEncoder(command: FfmpegCommand, codec: Exclude<VideoCodecName, "libx264">): Promise<boolean> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=128x128:d=0.1",
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    codec,
    "-f",
    "null",
    "-",
  ];
  const res = await runFfmpegCommand(command, args, TEST_ENCODE_TIMEOUT_MS);
  return res.ok;
}

export async function probeVideoEncoders(command: FfmpegCommand | null): Promise<EncoderDetectionResult> {
  if (!command) {
    return {
      ffmpegAvailable: false,
      command: null,
      listed: [],
      verifiedGpus: [],
      bestGpu: null,
      hasCpu: false,
    };
  }
  const listRes = await runFfmpegCommand(command, ["-hide_banner", "-encoders"], LIST_TIMEOUT_MS);
  if (!listRes.ok) {
    return {
      ffmpegAvailable: true,
      command,
      listed: [],
      verifiedGpus: [],
      bestGpu: null,
      hasCpu: false,
    };
  }
  const listed = parseEncodersList(listRes.stdout);
  const hasCpu = listed.includes("libx264");
  const verifiedGpus: Exclude<VideoCodecName, "libx264">[] = [];
  for (const candidate of GPU_CANDIDATES) {
    if (!listed.includes(candidate)) continue;
    if (await verifyEncoder(command, candidate)) {
      verifiedGpus.push(candidate);
      // Stop after verifying the highest-priority working GPU encoder to keep startup fast.
      break;
    }
  }
  return {
    ffmpegAvailable: true,
    command,
    listed,
    verifiedGpus,
    bestGpu: verifiedGpus[0] ?? null,
    hasCpu,
  };
}

/**
 * Detects ffmpeg and the best working H.264 encoder (NVENC → QSV → AMF → libx264).
 * Runs once per process and caches the result on `globalThis`.
 */
export function detectVideoEncoders(findFfmpegFn?: () => Promise<FfmpegCommand | null>): Promise<EncoderDetectionResult> {
  if (findFfmpegFn) {
    return findFfmpegFn().then((cmd) => probeVideoEncoders(cmd));
  }
  const state = encoderState();
  state.promise ??= findFfmpeg().then((cmd) => probeVideoEncoders(cmd));
  return state.promise;
}

export function resetEncoderCache(): void {
  encoderState().promise = null;
}

function gpuDisplayLabel(codec: Exclude<VideoCodecName, "libx264">): string {
  switch (codec) {
    case "h264_nvenc":
      return "Using NVIDIA GPU (h264_nvenc)";
    case "h264_qsv":
      return "Using Intel GPU (h264_qsv)";
    case "h264_amf":
      return "Using AMD GPU (h264_amf)";
  }
}

export function selectVideoEncoder(
  preference: OfflineVideoEncoder,
  info: Pick<EncoderDetectionResult, "ffmpegAvailable" | "bestGpu" | "hasCpu">,
): OfflineEncoderStatus {
  if (!info.ffmpegAvailable) {
    return {
      ffmpegAvailable: false,
      codec: null,
      bestGpu: null,
      fallback: false,
      label: "ffmpeg not found — videos can't be saved offline",
    };
  }
  if (preference === "cpu") {
    if (info.hasCpu) {
      return {
        ffmpegAvailable: true,
        codec: "libx264",
        bestGpu: info.bestGpu,
        fallback: false,
        label: "Using CPU (libx264)",
      };
    }
    return {
      ffmpegAvailable: true,
      codec: null,
      bestGpu: info.bestGpu,
      fallback: false,
      label: "No H.264 encoder available in ffmpeg",
    };
  }
  if (preference === "gpu") {
    if (info.bestGpu) {
      return {
        ffmpegAvailable: true,
        codec: info.bestGpu,
        bestGpu: info.bestGpu,
        fallback: false,
        label: gpuDisplayLabel(info.bestGpu),
      };
    }
    if (info.hasCpu) {
      return {
        ffmpegAvailable: true,
        codec: "libx264",
        bestGpu: null,
        fallback: true,
        label: "No GPU encoder available — falling back to CPU (libx264)",
      };
    }
    return {
      ffmpegAvailable: true,
      codec: null,
      bestGpu: null,
      fallback: false,
      label: "No H.264 encoder available in ffmpeg",
    };
  }
  // preference === "auto"
  if (info.bestGpu) {
    return {
      ffmpegAvailable: true,
      codec: info.bestGpu,
      bestGpu: info.bestGpu,
      fallback: false,
      label: gpuDisplayLabel(info.bestGpu),
    };
  }
  if (info.hasCpu) {
    return {
      ffmpegAvailable: true,
      codec: "libx264",
      bestGpu: null,
      fallback: false,
      label: "Using CPU (libx264)",
    };
  }
  return {
    ffmpegAvailable: true,
    codec: null,
    bestGpu: null,
    fallback: false,
    label: "No H.264 encoder available in ffmpeg",
  };
}

export async function getOfflineEncoderStatus(preference: OfflineVideoEncoder): Promise<OfflineEncoderStatus> {
  const info = await detectVideoEncoders();
  return selectVideoEncoder(preference, info);
}

/** Builds ffmpeg arguments to transcode a video to an H.264 + AAC faststart MP4 without upscaling. */
export function buildVideoTranscodeArgs(
  inputPath: string,
  outputPath: string,
  video: OfflineVideoSettings,
  codec: VideoCodecName,
): string[] {
  const maxrate = Math.round(video.bitrateKbps * 1.5);
  const bufsize = video.bitrateKbps * 2;
  const videoArgs: string[] =
    codec === "libx264"
      ? [
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-threads",
          String(video.cpuThreads),
          "-b:v",
          `${video.bitrateKbps}k`,
          "-maxrate",
          `${maxrate}k`,
          "-bufsize",
          `${bufsize}k`,
        ]
      : codec === "h264_nvenc"
        ? [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-b:v",
            `${video.bitrateKbps}k`,
            "-maxrate",
            `${maxrate}k`,
            "-bufsize",
            `${bufsize}k`,
          ]
        : [
            "-c:v",
            codec,
            "-b:v",
            `${video.bitrateKbps}k`,
            "-maxrate",
            `${maxrate}k`,
            "-bufsize",
            `${bufsize}k`,
          ];

  const audioArgs: string[] =
    video.audio === "drop"
      ? ["-an"]
      : ["-c:a", "aac", "-b:a", `${video.audioKbps}k`, "-ac", "2"];

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-vf",
    `scale=-2:'trunc(min(${video.maxHeight},ih)/2)*2'`,
    "-pix_fmt",
    "yuv420p",
    ...videoArgs,
    ...audioArgs,
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}
