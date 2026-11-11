import { HistoryList } from "@/components/history-list";
import { requireSetup } from "@/server/setup";
import { listRuns } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  await requireSetup();
  const runs = await listRuns();

  return (
    <main className="pt-12 pb-16">
      <HistoryList runs={runs} now={Date.now()} />
    </main>
  );
}
