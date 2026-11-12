import type { LogLine } from "@/components/ui/log-view";
import { describe, expect, it } from "vitest";
import {
  EMPTY,
  MAX_LINES,
  isTerminalStatus,
  reduceEvents,
} from "@/components/run-stream-reducer";
import { DEFAULT_ADVANCED } from "@/lib/spec";
import type { JobSpec, Run, RunStatus, StreamEvent } from "@/lib/spec";

/** Line ids are only React keys; the tests compare what is shown. */
function withoutIds(lines: readonly LogLine[]): LogLine[] {
  return lines.map(({ id: _id, ...line }) => line);
}

const NOW = 1_700_000_000_000;

const SPEC: JobSpec = {
  site: "x",
  account: "username",
  media: "images",
  layout: { kind: "byType" },
  simulate: false,
  advanced: { ...DEFAULT_ADVANCED, cookies: { browser: "firefox" } },
};

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "2026-11-11T09-14-02_username",
    spec: SPEC,
    steps: [{ label: "images", argv: ["gallery-dl"] }],
    status: "running",
    stepIndex: 0,
    counts: { saved: 0, skipped: 0, failed: 0 },
    ...overrides,
  };
}

describe("reduceEvents", () => {
  it("builds state from a live sequence", () => {
    const run = makeRun();
    const state = reduceEvents(
      EMPTY,
      [
        { t: "run", run },
        { t: "file", kind: "saved", path: "D:/x/Image/1_1.jpg" },
        { t: "log", level: "info", line: "[twitter][info] Initializing" },
        { t: "file", kind: "skipped", path: "D:/x/Image/2_1.jpg" },
        { t: "counts", saved: 1, skipped: 1, failed: 0 },
        { t: "wait", reason: "rateLimit", seconds: 120, attempt: 1, of: 4 },
        { t: "status", status: "running", stepIndex: 0 },
      ],
      NOW,
    );

    expect(state.run).toEqual(run);
    expect(state.counts).toEqual({ saved: 1, skipped: 1, failed: 0 });
    expect(state.currentFile).toBe("D:/x/Image/2_1.jpg");
    expect(withoutIds(state.lines)).toEqual([
      { text: "D:/x/Image/1_1.jpg", level: "info" },
      { text: "[twitter][info] Initializing", level: "info" },
      { text: "# D:/x/Image/2_1.jpg", level: "skip" },
    ]);
    expect(state.wait).toEqual({ until: NOW + 120_000, attempt: 1, of: 4 });
  });

  it("takes the counts of the run snapshot", () => {
    const run = makeRun({ counts: { saved: 5, skipped: 3, failed: 1 } });
    expect(reduceEvents(EMPTY, [{ t: "run", run }], NOW).counts).toEqual({ saved: 5, skipped: 3, failed: 1 });
  });

  it("applies the same replay twice to the same state, as an SSE reconnect does", () => {
    const run = makeRun();
    const connection: StreamEvent[] = [
      { t: "run", run },
      { t: "file", kind: "saved", path: "D:/x/Image/1_1.jpg" },
      { t: "log", level: "info", line: "[twitter][info] Initializing" },
      { t: "file", kind: "skipped", path: "D:/x/Image/2_1.jpg" },
      { t: "counts", saved: 1, skipped: 1, failed: 0 },
      { t: "status", status: "running", stepIndex: 0 },
    ];

    const once = reduceEvents(EMPTY, connection, NOW);
    const twice = reduceEvents(once, connection, NOW);

    expect({ ...twice, lines: withoutIds(twice.lines) }).toEqual({ ...once, lines: withoutIds(once.lines) });
    expect(twice.lines).toHaveLength(3);
    expect(twice.counts).toEqual({ saved: 1, skipped: 1, failed: 0 });
  });

  it("rebuilds a mid-run reconnect instead of appending the buffer", () => {
    const run = makeRun();
    const firstHalf: StreamEvent[] = [
      { t: "run", run },
      { t: "file", kind: "saved", path: "D:/x/Image/1_1.jpg" },
    ];
    const wholeConnection: StreamEvent[] = [
      { t: "run", run },
      { t: "file", kind: "saved", path: "D:/x/Image/1_1.jpg" },
      { t: "file", kind: "saved", path: "D:/x/Image/2_1.jpg" },
      { t: "counts", saved: 2, skipped: 0, failed: 0 },
      { t: "status", status: "running", stepIndex: 0 },
    ];

    const reconnected = reduceEvents(reduceEvents(EMPTY, firstHalf, NOW), wholeConnection, NOW);

    expect(withoutIds(reconnected.lines)).toEqual(withoutIds(reduceEvents(EMPTY, wholeConnection, NOW).lines));
    expect(reconnected.counts).toEqual({ saved: 2, skipped: 0, failed: 0 });
  });

  it("drops the previous run's log, file and wait when a new snapshot arrives", () => {
    const run = makeRun();
    const before = reduceEvents(
      EMPTY,
      [
        { t: "run", run },
        { t: "file", kind: "saved", path: "D:/x/Image/1_1.jpg" },
        { t: "wait", reason: "rateLimit", seconds: 60, attempt: 0, of: 0 },
      ],
      NOW,
    );

    const after = reduceEvents(
      before,
      [{ t: "run", run: makeRun({ counts: { saved: 9, skipped: 0, failed: 0 } }) }],
      NOW,
    );

    expect(after.lines).toEqual([]);
    expect(after.currentFile).toBeUndefined();
    expect(after.wait).toBeUndefined();
    expect(after.counts).toEqual({ saved: 9, skipped: 0, failed: 0 });
  });

  it("clears a replayed wait when a later file arrives in the same replay", () => {
    const run = makeRun();
    const connection: StreamEvent[] = [
      { t: "run", run },
      { t: "wait", reason: "rateLimit", seconds: 120, attempt: 1, of: 4 },
      { t: "file", kind: "saved", path: "D:/x/Image/1_1.jpg" },
      { t: "counts", saved: 1, skipped: 0, failed: 0 },
      { t: "status", status: "running", stepIndex: 0 },
    ];

    const once = reduceEvents(EMPTY, connection, NOW);
    const replayed = reduceEvents(once, connection, NOW);

    expect(once.wait).toBeUndefined();
    expect(replayed.wait).toBeUndefined();
  });

  it("keeps a wait that is the last event", () => {
    const run = makeRun();
    const state = reduceEvents(
      EMPTY,
      [
        { t: "run", run },
        { t: "file", kind: "saved", path: "D:/x/Image/1_1.jpg" },
        { t: "wait", reason: "rateLimit", seconds: 31, attempt: 0, of: 0 },
        { t: "status", status: "running", stepIndex: 0 },
      ],
      NOW,
    );

    expect(state.wait).toEqual({ until: NOW + 31_000, attempt: 0, of: 0 });
  });

  it("clears the wait and keeps the counts on a terminal status", () => {
    const run = makeRun();
    const state = reduceEvents(
      EMPTY,
      [
        { t: "run", run },
        { t: "wait", reason: "rateLimit", seconds: 120, attempt: 1, of: 4 },
        { t: "counts", saved: 4, skipped: 2, failed: 1 },
        { t: "status", status: "failed", stepIndex: 0 },
      ],
      NOW,
    );

    expect(state.wait).toBeUndefined();
    expect(state.run?.status).toBe("failed");
    expect(state.counts).toEqual({ saved: 4, skipped: 2, failed: 1 });
  });

  it("keeps the last 500 lines", () => {
    const run = makeRun();
    const events: StreamEvent[] = [{ t: "run", run }];
    for (let index = 0; index < MAX_LINES + 25; index += 1) {
      events.push({ t: "log", level: "info", line: `line ${index}` });
    }

    const state = reduceEvents(EMPTY, events, NOW);

    expect(state.lines).toHaveLength(MAX_LINES);
    expect(state.lines[0].text).toBe("line 25");
    expect(state.lines[MAX_LINES - 1].text).toBe(`line ${MAX_LINES + 24}`);
  });

  it("masks secrets before they reach the lines and the current file", () => {
    const run = makeRun();
    const state = reduceEvents(
      EMPTY,
      [
        { t: "run", run },
        { t: "log", level: "info", line: "[cookies][info] Cookie: auth_token=abc123; ct0=zzz999" },
        { t: "log", level: "info", line: "proxy http://user:hunter2@10.0.0.1:8080" },
        { t: "file", kind: "saved", path: "D:/x/Image/https://u:p@host/1_1.jpg" },
      ],
      NOW,
    );

    expect(withoutIds(state.lines)).toEqual([
      { text: "[cookies][info] Cookie: ••••", level: "info" },
      { text: "proxy http://user:••••@10.0.0.1:8080", level: "info" },
      { text: "D:/x/Image/https://u:••••@host/1_1.jpg", level: "info" },
    ]);
    expect(state.currentFile).toBe("D:/x/Image/https://u:••••@host/1_1.jpg");
  });
});

describe("isTerminalStatus", () => {
  it("knows which statuses end a run", () => {
    const terminal: RunStatus[] = ["done", "failed", "stopped", "interrupted"];
    const active: RunStatus[] = ["queued", "running", "stopping"];
    expect(terminal.map(isTerminalStatus)).toEqual([true, true, true, true]);
    expect(active.map(isTerminalStatus)).toEqual([false, false, false]);
  });
});
