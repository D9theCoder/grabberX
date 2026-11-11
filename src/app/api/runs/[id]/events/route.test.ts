import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunEvent, RunStatus, StreamEvent } from "@/lib/spec";
import { GET } from "./route";

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: StreamEvent) => void>>();
  const unsubscribed: string[] = [];
  return {
    snapshot: vi.fn(),
    getRun: vi.fn(),
    listeners,
    unsubscribed,
    subscribe: vi.fn((id: string, listener: (event: StreamEvent) => void) => {
      const set = listeners.get(id) ?? new Set<(event: StreamEvent) => void>();
      set.add(listener);
      listeners.set(id, set);
      return () => {
        set.delete(listener);
        unsubscribed.push(id);
      };
    }),
    emit(id: string, event: StreamEvent): void {
      for (const listener of [...(listeners.get(id) ?? [])]) listener(event);
    },
  };
});

vi.mock("@/server/run-queue", () => ({
  runQueue: { snapshot: h.snapshot, subscribe: h.subscribe },
  isTerminalStatus: (status: RunStatus) =>
    ["done", "failed", "stopped", "interrupted"].includes(status),
}));

vi.mock("@/server/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/store")>();
  return { ...actual, getRun: h.getRun };
});

const ID = "2026-11-11T09-14-02_username";

function makeRun(status: RunStatus, stepIndex = 0): Run {
  return {
    id: ID,
    spec: {
      site: "x",
      account: "username",
      media: "all",
      layout: { kind: "byType" },
      simulate: false,
      advanced: {
        imageSize: "orig",
        retweets: false,
        replies: false,
        writeMetadata: false,
        noSkip: false,
        cookies: { browser: "firefox" },
      },
    },
    steps: [{ label: "images", argv: ["--version"] }],
    status,
    stepIndex,
    counts: { saved: 2, skipped: 1, failed: 0 },
  };
}

function callGet(id: string, signal?: AbortSignal): Promise<Response> {
  const request = new Request(`http://127.0.0.1:3210/api/runs/${id}/events`, { signal });
  return GET(request, { params: Promise.resolve({ id }) });
}

const decoder = new TextDecoder();

type EventBody = StreamEvent | undefined;

function bodyOf(chunk: string): EventBody {
  const line = chunk.split("\n").find((part) => part.startsWith("data: "));
  if (!line) return undefined;
  return JSON.parse(line.slice("data: ".length)) as StreamEvent;
}

interface ReadResult {
  text: string;
  done: boolean;
  event: EventBody;
}

async function read(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadResult> {
  const { value, done } = await reader.read();
  const text = value ? decoder.decode(value) : "";
  return { text, done, event: bodyOf(text) };
}

function readerFor(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("the route returned no body");
  return body.getReader();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.listeners.clear();
  h.unsubscribed.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/runs/[id]/events", () => {
  it("replays the run and its buffered events, then streams live events and closes", async () => {
    const run = makeRun("running");
    const buffered: RunEvent[] = [
      { t: "file", kind: "saved", path: "Image/a.jpg" },
      { t: "counts", saved: 1, skipped: 0, failed: 0 },
      { t: "status", status: "running", stepIndex: 0 },
    ];
    h.snapshot.mockReturnValue({ run, events: buffered });

    const response = await callGet(ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const reader = readerFor(response);

    expect((await read(reader)).event).toEqual({ t: "run", run });
    expect((await read(reader)).event).toEqual(buffered[0]);
    expect((await read(reader)).event).toEqual(buffered[1]);
    expect((await read(reader)).event).toEqual(buffered[2]);

    h.emit(ID, { t: "file", kind: "skipped", path: "Image/b.jpg" });
    expect((await read(reader)).event).toEqual({
      t: "file",
      kind: "skipped",
      path: "Image/b.jpg",
    });

    h.emit(ID, { t: "status", status: "done", stepIndex: 0 });
    expect((await read(reader)).event).toEqual({ t: "status", status: "done", stepIndex: 0 });

    const end = await read(reader);
    expect(end.done).toBe(true);
    expect(h.unsubscribed).toContain(ID);
  });

  it("closes immediately when the snapshot is already finished", async () => {
    const run = makeRun("done");
    h.snapshot.mockReturnValue({ run, events: [{ t: "status", status: "done", stepIndex: 0 }] });

    const response = await callGet(ID);
    const reader = readerFor(response);
    expect((await read(reader)).event).toEqual({ t: "run", run });
    expect((await read(reader)).event).toEqual({ t: "status", status: "done", stepIndex: 0 });
    expect((await read(reader)).done).toBe(true);
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("falls back to the stored run when nothing is in memory", async () => {
    h.snapshot.mockReturnValue(undefined);
    h.getRun.mockResolvedValue(makeRun("failed", 1));

    const response = await callGet(ID);
    const reader = readerFor(response);
    expect((await read(reader)).event).toMatchObject({ t: "run", run: { status: "failed" } });
    expect((await read(reader)).event).toEqual({
      t: "counts",
      saved: 2,
      skipped: 1,
      failed: 0,
    });
    expect((await read(reader)).event).toEqual({ t: "status", status: "failed", stepIndex: 1 });
    expect((await read(reader)).done).toBe(true);
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("reports a stored run without an owner as interrupted", async () => {
    h.snapshot.mockReturnValue(undefined);
    h.getRun.mockResolvedValue(makeRun("running"));

    const response = await callGet(ID);
    const reader = readerFor(response);
    await read(reader);
    await read(reader);
    expect((await read(reader)).event).toEqual({
      t: "status",
      status: "interrupted",
      stepIndex: 0,
    });
    expect((await read(reader)).done).toBe(true);
  });

  it("returns 404 for an unknown run", async () => {
    h.snapshot.mockReturnValue(undefined);
    h.getRun.mockResolvedValue(undefined);
    const response = await callGet(ID);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Run not found." });
  });

  it("returns 404 for an id that could escape the runs folder", async () => {
    const response = await callGet("../escape");
    expect(response.status).toBe(404);
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.getRun).not.toHaveBeenCalled();
  });

  it("pings every 15 seconds and unsubscribes on abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    h.snapshot.mockReturnValue({ run: makeRun("running"), events: [] });

    const response = await callGet(ID, controller.signal);
    const reader = readerFor(response);
    expect((await read(reader)).event).toMatchObject({ t: "run" });

    await vi.advanceTimersByTimeAsync(15000);
    expect((await read(reader)).text).toBe(": ping\n\n");

    await vi.advanceTimersByTimeAsync(15000);
    expect((await read(reader)).text).toBe(": ping\n\n");

    controller.abort();
    expect((await read(reader)).done).toBe(true);
    expect(h.unsubscribed).toContain(ID);
  });
});
