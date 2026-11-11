import type { ErrorKind, RunEvent } from "@/lib/spec";

const LOG_LINE = /^\[[^\]]+\]\[(debug|info|warning|error)\] ?(.*)$/;
const WAIT_LINE = /^Waiting for (.+?) until \d{2}:\d{2}:\d{2} \((.+)\)$/;

export function parseLine(
  stream: "stdout" | "stderr",
  rawLine: string,
): RunEvent | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.trim()) return null;
  return stream === "stdout" ? parseStdout(line) : parseStderr(line);
}

function parseStdout(line: string): RunEvent | null {
  if (line.startsWith("# ")) {
    return { t: "file", kind: "skipped", path: line.slice(2) };
  }
  return { t: "file", kind: "saved", path: line };
}

function parseStderr(line: string): RunEvent | null {
  const match = LOG_LINE.exec(line);
  if (!match) return { t: "log", level: "info", line };

  const level = match[1];
  const wait = parseWait(match[2]);
  if (wait) return wait;
  if (level === "error") return { t: "log", level: "error", line };
  if (level === "warning") return { t: "log", level: "warning", line };
  return { t: "log", level: "info", line };
}

/** `[twitter][info] Waiting for 2 minutes until 14:32:10 (rate limit)` */
function parseWait(message: string): RunEvent | null {
  const match = WAIT_LINE.exec(message);
  if (!match) return null;
  if (!/rate|429/i.test(match[2])) return null;
  const seconds = durationSeconds(match[1]);
  if (seconds === null) return null;
  return { t: "wait", reason: "rateLimit", seconds, attempt: 0, of: 0 };
}

function durationSeconds(text: string): number | null {
  const hours = /^(\d+)h (\d+)min$/.exec(text);
  if (hours) return Number(hours[1]) * 3600 + Number(hours[2]) * 60;
  const minutes = /^(\d+) minutes?$/.exec(text);
  if (minutes) return Number(minutes[1]) * 60;
  const seconds = /^(\d+) seconds?$/.exec(text);
  if (seconds) return Number(seconds[1]);
  return null;
}

const ERROR_RULES: [ErrorKind, RegExp][] = [
  ["diskFull", /no space left|disk full|enospc|not enough (disk )?space/i],
  ["auth", /auth|log ?in|\b401\b|\b403\b/i],
  [
    "notFound",
    /not found|could not be found|does not exist|no longer exists|suspended|deactivated/i,
  ],
  ["rateLimit", /\b429\b|rate limit|too many requests/i],
];

export function classifyError(line: string): ErrorKind | null {
  for (const [kind, pattern] of ERROR_RULES) {
    if (pattern.test(line)) return kind;
  }
  return null;
}
