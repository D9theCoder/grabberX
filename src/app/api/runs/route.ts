import { summarizeTasks } from "@/lib/task-list";
import { runQueue } from "@/server/run-queue";

export const dynamic = "force-dynamic";

/** Active and queued runs for the top-bar task bubble. */
export function GET(): Response {
  const tasks = summarizeTasks(runQueue.list(), (id) => runQueue.queuePosition(id));
  return Response.json({ tasks }, { headers: { "cache-control": "no-store" } });
}
