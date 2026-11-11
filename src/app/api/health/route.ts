import { appVersion } from "@/server/env";
import { runQueue } from "@/server/run-queue";

export const dynamic = "force-dynamic";

/** The shell polls this to know the server is up, and asks how many runs would be lost by quitting. */
export function GET(): Response {
  return Response.json({ ok: true, version: appVersion(), activeRuns: runQueue.list().length });
}
