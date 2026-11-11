import type { Run, RunEvent, RunStatus, StreamEvent } from "@/lib/spec";
import { isTerminalStatus, runQueue } from "@/server/run-queue";
import { getRun, isValidRunId } from "@/server/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PING_MS = 15000;

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function notFound(): Response {
  return Response.json({ error: "Run not found." }, { status: 404 });
}

function countsEvent(run: Run): RunEvent {
  return {
    t: "counts",
    saved: run.counts.saved,
    skipped: run.counts.skipped,
    failed: run.counts.failed,
  };
}

function streamResponse(
  request: Request,
  id: string,
  run: Run,
  initial: RunEvent[],
  live: boolean,
): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* the client already went away */
        }
      };

      request.signal.addEventListener("abort", close, { once: true });

      heartbeat = setInterval(() => {
        write(": ping\n\n");
      }, PING_MS);
      heartbeat.unref?.();

      write(`data: ${JSON.stringify({ t: "run", run } satisfies StreamEvent)}\n\n`);
      for (const event of initial) write(`data: ${JSON.stringify(event)}\n\n`);

      if (!live || isTerminalStatus(run.status)) {
        close();
        return;
      }

      unsubscribe = runQueue.subscribe(id, (event) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.t === "status" && isTerminalStatus(event.status)) close();
      });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/runs/[id]/events">,
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isValidRunId(id)) return notFound();

  const snapshot = runQueue.snapshot(id);
  if (snapshot) {
    return streamResponse(request, id, snapshot.run, snapshot.events, true);
  }

  const stored = await getRun(id);
  if (!stored) return notFound();

  // Nothing in memory means no process owns this run any more; boot recovery marks such records
  // interrupted, so report that instead of leaving a client waiting on a stream that never ends.
  const status: RunStatus = isTerminalStatus(stored.status) ? stored.status : "interrupted";
  const initial: RunEvent[] = [
    countsEvent(stored),
    { t: "status", status, stepIndex: stored.stepIndex },
  ];
  return streamResponse(request, id, stored, initial, false);
}
