"use client";

import { useEffect, useReducer, useState } from "react";
import type { RunStreamState } from "@/components/run-stream-reducer";
import { EMPTY, isTerminalStatus, reduceEvents } from "@/components/run-stream-reducer";
import type { StreamEvent } from "@/lib/spec";

export type { RunStreamState, RunWait } from "@/components/run-stream-reducer";

type Action = { type: "reset" } | { type: "batch"; events: StreamEvent[] };

function reducer(state: RunStreamState, action: Action): RunStreamState {
  if (action.type === "reset") return EMPTY;
  return reduceEvents(state, action.events);
}

/**
 * Subscribes to a run's SSE stream. Events are queued and applied once per animation frame, so a burst of
 * thousands of "# skipped" lines costs at most 60 renders a second.
 */
export function useRunStream(runId: string | null): RunStreamState {
  const [state, dispatch] = useReducer(reducer, EMPTY);

  // React re-renders immediately when a component updates its own state during render, so the previous
  // run's panel never paints for a frame after "Run again" swaps the id. An effect would run too late.
  // The previous id lives in state, not a ref: a render React throws away (StrictMode, interruptions) must
  // not leave a half-applied "already reset" marker behind.
  const [builtFor, setBuiltFor] = useState(runId);
  if (builtFor !== runId) {
    setBuiltFor(runId);
    dispatch({ type: "reset" });
  }

  useEffect(() => {
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
      if (event.t === "status" && isTerminalStatus(event.status)) source.close();
    };

    return () => {
      source.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [runId]);

  return state;
}
