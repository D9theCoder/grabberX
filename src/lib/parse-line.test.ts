import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyError, parseLine } from "@/lib/parse-line";
import type { ErrorKind, RunEvent } from "@/lib/spec";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

const fixtureFiles = readdirSync(FIXTURES).filter((file) => file.endsWith(".txt"));

function streamOf(file: string): "stdout" | "stderr" {
  return file.includes(".stdout.") ? "stdout" : "stderr";
}

function linesOf(file: string): string[] {
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function eventsOf(file: string): RunEvent[] {
  return linesOf(file)
    .map((line) => parseLine(streamOf(file), line))
    .filter((event): event is RunEvent => event !== null);
}

function kindsOf(file: string): RunEvent["t"][] {
  return eventsOf(file).map((event) => event.t);
}

describe("fixtures", () => {
  it("finds the captured gallery-dl output", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(10);
  });

  it("parses every line of every fixture", () => {
    for (const file of fixtureFiles) {
      for (const line of linesOf(file)) {
        const event = parseLine(streamOf(file), line);
        expect(event, `${file}: ${line}`).not.toBeNull();
        expect(["status", "file", "log", "wait"]).toContain(event?.t);
      }
    }
  });

  it("reads a real two-file download", () => {
    const events = eventsOf("x-download.stdout.txt");
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({ t: "file", kind: "saved" });
    }
    expect(events.map((event) => (event.t === "file" ? event.path : ""))).toEqual([
      "C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\gdlfix\\dl\\username\\Image\\2117972873772179592_2.jpg",
      "C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\gdlfix\\dl\\username\\Image\\2116525825579430345_2.jpg",
    ]);
  });

  it("reads a real skip run", () => {
    const events = eventsOf("x-skip.stdout.txt");
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.t).toBe("file");
      if (event.t !== "file") continue;
      expect(event.kind).toBe("skipped");
      expect(event.path.startsWith("#")).toBe(false);
      expect(event.path.endsWith("_2.jpg")).toBe(true);
    }
  });

  it("reads a --simulate run (bare filenames)", () => {
    const events = eventsOf("x-simulate.stdout.txt");
    expect(events).toEqual([
      { t: "file", kind: "skipped", path: "2117972873772179592_2.jpg" },
      { t: "file", kind: "skipped", path: "2116525825579430345_2.jpg" },
    ]);
  });

  it("reads a video step", () => {
    const events = eventsOf("x-video.stdout.txt");
    expect(events).toHaveLength(1);
    expect(events[0].t === "file" && events[0].path.endsWith("_1.mp4")).toBe(true);
  });

  it("parses the info lines gallery-dl writes to stderr", () => {
    expect(kindsOf("x-download.stderr.txt")).toEqual(["log", "log"]);
    expect(eventsOf("x-simulate.stderr.txt")).toEqual([
      {
        t: "log",
        level: "info",
        line: "[cookies][info] Extracted 129 cookies from Firefox",
      },
    ]);
  });

  it("parses a real NotFound error", () => {
    const events = eventsOf("x-error-notfound.stderr.txt");
    expect(events).toHaveLength(2);
    expect(events[1].t === "log" && events[1].level).toBe("error");
    const line = events[1].t === "log" ? events[1].line : "";
    expect(line).toContain("NotFoundError: Requested user could not be found");
    expect(classifyError(line)).toBe("notFound");
  });

  it("reads a rate-limit wait (unverified fixture)", () => {
    const events = eventsOf("x-rate-limit-unverified.stderr.txt");
    expect(events[0]).toEqual({
      t: "wait",
      reason: "rateLimit",
      seconds: 120,
      attempt: 0,
      of: 0,
    });
    expect(events[1].t === "log" && events[1].level).toBe("warning");
    const line = events[1].t === "log" ? events[1].line : "";
    expect(classifyError(line)).toBe("rateLimit");
  });

  it("classifies an auth error (unverified fixture)", () => {
    const events = eventsOf("x-auth-error-unverified.stderr.txt");
    expect(events[1].t === "log" && events[1].level).toBe("error");
    const line = events[1].t === "log" ? events[1].line : "";
    expect(line).toContain("AuthRequired");
    expect(classifyError(line)).toBe("auth");
  });

  it("classifies a full disk (unverified fixture)", () => {
    const events = eventsOf("x-disk-full-unverified.stderr.txt");
    const line = events[0].t === "log" ? events[0].line : "";
    expect(classifyError(line)).toBe("diskFull");
  });
});

describe("parseLine", () => {
  it("ignores blank lines", () => {
    expect(parseLine("stdout", "")).toBeNull();
    expect(parseLine("stdout", "\r")).toBeNull();
    expect(parseLine("stderr", "   ")).toBeNull();
  });

  it("strips a trailing carriage return", () => {
    expect(parseLine("stdout", "D:/x/a_1.jpg\r")).toEqual({
      t: "file",
      kind: "saved",
      path: "D:/x/a_1.jpg",
    });
  });

  it("treats an unlabelled stderr line as info", () => {
    expect(parseLine("stderr", "Traceback (most recent call last):")).toEqual({
      t: "log",
      level: "info",
      line: "Traceback (most recent call last):",
    });
  });

  it("reads waits in every duration shape gallery-dl prints", () => {
    const cases: [string, number][] = [
      ["Waiting for 31 seconds until 10:00:00 (429 Too Many Requests)", 31],
      ["Waiting for 2 minutes until 14:32:10 (rate limit)", 120],
      ["Waiting for 1h 5min until 15:00:00 (rate limit)", 3900],
    ];
    for (const [message, seconds] of cases) {
      expect(parseLine("stderr", `[twitter][info] ${message}`)).toEqual({
        t: "wait",
        reason: "rateLimit",
        seconds,
        attempt: 0,
        of: 0,
      });
    }
  });

  it("keeps an unrelated wait as a log line", () => {
    expect(
      parseLine("stderr", "[twitter][info] Waiting for 5 seconds until 10:00:00 (proxy)"),
    ).toEqual({
      t: "log",
      level: "info",
      line: "[twitter][info] Waiting for 5 seconds until 10:00:00 (proxy)",
    });
  });

  it("falls back to a log line when the duration is unknown", () => {
    const line = "[twitter][warning] Waiting for a while until 10:00:00 (rate limit)";
    expect(parseLine("stderr", line)).toEqual({ t: "log", level: "warning", line });
  });
});

describe("classifyError", () => {
  const cases: [string, ErrorKind | null][] = [
    ["[twitter][error] AuthRequired: authenticated cookies needed to access this timeline", "auth"],
    ["[twitter][error] AuthenticationError: Invalid login credentials", "auth"],
    ["[twitter][warning] '403 Forbidden' for 'https://x.com/i/api/graphql/x'", "auth"],
    ["[twitter][error] NotFoundError: Requested user could not be found", "notFound"],
    ["[twitter][error] This account does not exist", "notFound"],
    ["[twitter][error] Account suspended", "notFound"],
    ["[twitter][warning] '429 Too Many Requests' for 'https://x.com/x'", "rateLimit"],
    ["[twitter][info] rate limit reached", "rateLimit"],
    ["[download][error] OSError: [Errno 28] No space left on device", "diskFull"],
    ["[download][error] Disk full while writing", "diskFull"],
    ["[cookies][info] Extracted 129 cookies from Firefox", null],
    ["[twitter][error] Failed to download https://pbs.twimg.com/media/x.jpg", null],
  ];

  it.each(cases)("classifies %s", (line, expected) => {
    expect(classifyError(line)).toBe(expected);
  });
});
