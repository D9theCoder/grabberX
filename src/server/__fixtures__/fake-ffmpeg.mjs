// Fake ffmpeg executable for unit tests (invoked via `node fake-ffmpeg.mjs ...`).
// Supports:
// - `-version`: prints version banner and exits 0
// - `-encoders`: prints FAKE_FFMPEG_ENCODERS (or default libx264) and exits 0
// - `-f null -`: tiny encoder verification probe; honors FAKE_FFMPEG_WORKING_ENCODERS (comma list)
// - `-f mp4 <outputPath>`: writes a fake MP4 file at <outputPath>; honors FAKE_FFMPEG_FAIL_CODECS
// - default (webp thumb to stdout): writes a minimal 1x1 WebP image on stdout
// Records calls to FAKE_FFMPEG_LOG (if set).
import { appendFileSync, writeFileSync } from "node:fs";
import { getPriority } from "node:os";

// Valid 1x1 lossless WebP (RIFF....WEBP VP8L).
const WEBP_1X1 = Buffer.from(
  "UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",
  "base64",
);

// Minimal fake MP4 ftyp header + payload bytes for tests.
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]),
  Buffer.alloc(1024, 0x42),
]);

const args = process.argv.slice(2);
const delayMs = Number(process.env.FAKE_FFMPEG_DELAY_MS ?? "0");
const fail = process.env.FAKE_FFMPEG_FAIL === "1";
const logPath = process.env.FAKE_FFMPEG_LOG;

function codecFromArgs(argv) {
  const idx = argv.indexOf("-c:v");
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  const vidx = argv.indexOf("-vcodec");
  if (vidx !== -1 && vidx + 1 < argv.length) return argv[vidx + 1];
  return null;
}

async function main() {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (logPath) {
    let prio = null;
    try {
      prio = getPriority(process.pid);
    } catch {
      prio = null;
    }
    appendFileSync(
      logPath,
      `${JSON.stringify({ pid: process.pid, priority: prio, args })}\n`,
    );
  }
  if (fail) {
    process.exit(1);
  }

  if (args.includes("-version")) {
    process.stdout.write("ffmpeg version fake-1.0\n");
    return;
  }

  if (args.includes("-encoders")) {
    const listed = (process.env.FAKE_FFMPEG_ENCODERS ?? "libx264")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const lines = [
      "Encoders:",
      " V..... = Video",
      " ------",
      ...listed.map((name) => ` V..... ${name.padEnd(20)} Fake ${name} encoder`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const codec = codecFromArgs(args);

  // Tiny verification probe (`-f null -`) — use lastIndexOf because `-f lavfi` precedes `-f null`.
  const fIdx = args.lastIndexOf("-f");
  if (fIdx !== -1 && args[fIdx + 1] === "null") {
    const workingRaw = process.env.FAKE_FFMPEG_WORKING_ENCODERS;
    if (workingRaw !== undefined) {
      const working = new Set(
        workingRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      if (!codec || !working.has(codec)) {
        process.exit(1);
      }
    }
    return;
  }

  // MP4 file output (`-f mp4 <outputPath>`)
  if (fIdx !== -1 && args[fIdx + 1] === "mp4") {
    const failCodecs = new Set(
      (process.env.FAKE_FFMPEG_FAIL_CODECS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (codec && failCodecs.has(codec)) {
      process.exit(1);
    }
    const outputPath = args[args.length - 1];
    if (!outputPath || outputPath === "pipe:1") {
      process.exit(1);
    }
    writeFileSync(outputPath, FAKE_MP4);
    return;
  }

  process.stdout.write(WEBP_1X1);
}

void main();
