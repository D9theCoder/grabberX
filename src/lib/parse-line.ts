import type { ErrorKind, RunEvent } from "@/lib/spec";

const LOG_LINE = /^\[[^\]]+\]\[(debug|info|warning|error)\] ?(.*)$/;
const WAIT_LINE = /^Waiting for (.+?) until \d{1,2}:\d{2}:\d{2} \((.+)\)$/;
const RATE_LIMIT_REASON = /\brate ?limits?\b|\b429\b/i;
const DURATION_PART = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;

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
  // A wait is a progress hint. An error line has to stay an error: the queue counts failed files and
  // picks the run's errorKind from log/error events, so hiding one behind a countdown loses the cause.
  if (level !== "error") {
    const wait = parseWait(match[2]);
    if (wait) return wait;
  }
  if (level === "error") return { t: "log", level: "error", line };
  if (level === "warning") return { t: "log", level: "warning", line };
  return { t: "log", level: "info", line };
}

/** `[twitter][info] Waiting for 2 minutes until 14:32:10 (rate limit)` */
function parseWait(message: string): RunEvent | null {
  const match = WAIT_LINE.exec(message);
  if (!match) return null;
  if (!RATE_LIMIT_REASON.test(match[2])) return null;
  const seconds = durationSeconds(match[1]);
  if (seconds === null) return null;
  return { t: "wait", reason: "rateLimit", seconds, attempt: 0, of: 0 };
}

/** Sums every "<n> <unit>" part, so "1h 5min", "2 minutes", "31 seconds" and "45s" all read. */
function durationSeconds(text: string): number | null {
  // Units the parts below cannot add up: summing only the hours of "1 day 5 hours" would hide 24 of 29.
  if (/\b(?:days?|weeks?)\b/i.test(text)) return null;
  let total = 0;
  let parts = 0;
  for (const match of text.matchAll(DURATION_PART)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const scale = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
    total += value * scale;
    parts += 1;
  }
  // A day-long wait means the line was not a backoff message; better a plain log line than a bogus clock.
  if (parts === 0 || total <= 0 || total > 86400) return null;
  return total;
}

/**
 * Most specific first. A 403 page can still say the account does not exist, and the cheapest mistake
 * to make is telling the user to sign in again for a problem that signing in cannot fix.
 *
 * The status codes are guarded so a URL path or a file name (".../403.jpg") cannot read as one.
 */
const ERROR_RULES: [ErrorKind, RegExp][] = [
  ["diskFull", /no space left|disk full|enospc|not enough (disk )?space/i],
  [
    "notFound",
    /\bnot ?found|could not be found|does not exist|no longer exists|suspended|deactivated/i,
  ],
  ["rateLimit", /(?<![/\w])429\b(?!\.\w)|rate ?limits?|too many requests/i],
  // Word-anchored on purpose: "author", "authority", "authored by" and "plugin" are not auth failures.
  [
    "auth",
    /\bauth(?:(?:entication|enticate[ds]?|enticator|orization|orized|orised)(?:error)?|error|required)?\b|\blog ?in(?:error|required)?\b|(?<!\bno )\bcookies needed\b/i,
  ],
  ["auth", /(?<![/\w])40[13]\b(?!\.\w)/i],
  ["auth", /\bunauthori[sz]ed\b|\bunauthenticated\b/i],
];

export function classifyError(line: string): ErrorKind | null {
  for (const [kind, pattern] of ERROR_RULES) {
    if (pattern.test(line)) return kind;
  }
  return null;
}
