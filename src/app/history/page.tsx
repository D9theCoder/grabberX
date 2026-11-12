import { HistoryList } from "@/components/history-list";
import { LiveRefresh } from "@/components/live-refresh";
import { isActiveStatus } from "@/lib/run-copy";
import { listRunsLive } from "@/server/history";
import { requireSetup } from "@/server/setup";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  await requireSetup();
  const runs = await listRunsLive();

  return (
    <main className="pt-12 pb-16">
      <LiveRefresh active={runs.some((run) => isActiveStatus(run.status))} />
      <HistoryList runs={runs} now={Date.now()} />
    </main>
  );
}
