import { LibraryTable } from "@/components/library-table";
import { getAccountStats, listAccounts } from "@/server/library";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const accounts = await listAccounts();

  // Sizes are not awaited here: the table renders now and each row fills in when its folder scan finishes.
  const rows = accounts.map((entry) => ({ entry, stats: getAccountStats(entry.folder) }));

  return (
    <main className="pt-12 pb-16">
      <LibraryTable rows={rows} />
    </main>
  );
}
