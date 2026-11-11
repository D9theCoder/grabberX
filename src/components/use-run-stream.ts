"use client";

import { useEffect, useReducer } from "react";
import type { LogLine } from "@/components/ui/log-view";
import type { Counts, Run, RunStatus, StreamEvent } from "@/lib/spec";

const MAX_LINES = 500;
const TERMINAL: RunStatus[] = ["done", "failed", "stopped", "interrupted"];

export interface RunWait {
  until: number;
  attempt: number;
  of: number;
}

export interface RunStreamState {
  run?: Run;
  counts: Counts;
  currentFile?: string;
  lines: LogLine[];
  wait?: RunWait;
}

const EMPTY: RunStreamState = { counts: { saved: 0, skipped: 0, failed: 0 }, lines: [] };

type Action = { type: "reset" } | { type: "batch"; events: StreamEvent[] };

function pushLine(lines: LogLine[], line: LogLine): LogLine[] {
  const next = lines.length >= MAX_LINES ? lines.slice(lines.length - MAX_LINES + 1) : lines.slice();
  next.push(line);
  return next;
}

function apply(state: RunStreamState, event: StreamEvent): RunStreamState {
  switch (event.t) {
    case "run":
      return { ...state, run: event.run, counts: event.run.counts };
    case "status":
      return {
        ...state,
        run: state.run && { ...state.run, status: event.status, stepIndex: event.stepIndex },
        wait: event.status === "running" ? state.wait : undefined,
      };
    case "counts":
      return { ...state, counts: { saved: event.saved, skipped: event.skipped, failed: event.failed } };
    case "file":
      return {
        ...state,
        currentFile: event.path,
        wait: undefined,
        lines: pushLine(state.lines, {
          text: event.kind === "skipped" ? `# ${event.path}` : event.path,
          level: event.kind === "skipped" ? "skip" : "info",
        }),
      };
    case "log":
      return {
        ...state,
        lines: pushLine(state.lines, { text: event.line, level: event.level }),
      };
    case "wait":
      return { ...state, wait: { until: Date.now() + event.seconds * 1000, attempt: event.attempt, of: event.of } };
  }
}

function reducer(state: RunStreamState, action: Action): RunStreamState {
  if (action.type === "reset") return EMPTY;
  return action.events.reduce(apply, state);
}

/**
 * Subscribes to a run's SSE stream. Events are queued and applied once per animation frame, so a burst of
 * thousands of "# skipped" lines costs at most 60 renders a second.
 */
export function useRunStream(runId: string | null): RunStreamState {
  const [state, dispatch] = useReducer(reducer, EMPTY);

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!runId) return;

    let queue: StreamEvent[] = [];
    let frame = 0;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);

    function flush() {
      frame = 0;
      const events = queue;
      queue = [];
      if (events.length > 0) dispatch({ type: "batch", events });
    }

    source.onmessage = (message) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(message.data) as StreamEvent;
      } catch {
        return;
      }
      queue.push(event);
      if (!frame) frame = requestAnimationFrame(flush);
      // The server closes the stream after a final status; without this EventSource would reconnect forever.
      if (event.t === "status" && TERMINAL.includes(event.status)) source.close();
    };

    return () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [runId]);

  return state;
}
