import type { LogLine } from "@/components/ui/log-view";
import { maskSecrets } from "@/lib/mask";
import type { Counts, Run, RunStatus, StreamEvent } from "@/lib/spec";

export const MAX_LINES = 500;

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "stopped", "interrupted"]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

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

export const EMPTY: RunStreamState = { counts: { saved: 0, skipped: 0, failed: 0 }, lines: [] };

let nextLineId = 0;

function pushLine(lines: LogLine[], line: LogLine): LogLine[] {
  const next = lines.length >= MAX_LINES ? lines.slice(lines.length - MAX_LINES + 1) : lines.slice();
  nextLineId += 1;
  next.push({ ...line, id: nextLineId });
  return next;
}

function apply(state: RunStreamState, event: StreamEvent, now: number): RunStreamState {
  switch (event.t) {
    case "run":
      // Every SSE connection opens with this snapshot, so a reconnect (dropped connection, laptop
      // sleep, proxy timeout) replays its buffer: start from empty or the replay doubles every line.
      return { run: event.run, counts: { ...event.run.counts }, lines: [] };
    case "status":
      return {
        ...state,
        run: state.run && { ...state.run, status: event.status, stepIndex: event.stepIndex },
        wait: event.status === "running" ? state.wait : undefined,
      };
    case "counts":
      return { ...state, counts: { saved: event.saved, skipped: event.skipped, failed: event.failed } };
    case "file": {
      const path = maskSecrets(event.path);
      return {
        ...state,
        currentFile: path,
        wait: undefined,
        lines: pushLine(state.lines, {
          text: event.kind === "skipped" ? `# ${path}` : path,
          level: event.kind === "skipped" ? "skip" : "info",
        }),
      };
    }
    case "log":
      return {
        ...state,
        lines: pushLine(state.lines, { text: maskSecrets(event.line), level: event.level }),
      };
    case "wait":
      return {
        ...state,
        wait: { until: now + event.seconds * 1000, attempt: event.attempt, of: event.of },
      };
  }
}

/** Applies events in order. Pure: the countdown needs a clock, so callers pass one (tests pin it). */
export function reduceEvents(
  state: RunStreamState,
  events: readonly StreamEvent[],
  now: number = Date.now(),
): RunStreamState {
  return events.reduce((current, event) => apply(current, event, now), state);
}
