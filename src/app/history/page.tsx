import { HistoryList } from "@/components/history-list";
import { listRuns } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const runs = await listRuns();

  return (
    <main className="pt-12 pb-16">
      <HistoryList runs={runs} />
    </main>
  );
}
