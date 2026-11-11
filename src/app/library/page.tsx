import Link from "next/link";
import { LibraryTable } from "@/components/library-table";
import { getAccountStats, listAccounts } from "@/server/library";
import { requireSetup } from "@/server/setup";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  await requireSetup();
  const accounts = await listAccounts();
  const now = Date.now();

  // An empty library only needs one way forward: the Run page. The table draws its own header.
  if (accounts.length === 0) {
    return (
      <main className="pt-12 pb-16">
        <h1 className="m-0 text-display">Library</h1>
        <p className="mt-6 text-body text-ink-2">
          No accounts yet. Your first download will show up here.{" "}
          <Link href="/" className="text-ink underline underline-offset-2">
            Start a download
          </Link>
        </p>
      </main>
    );
  }

  // Sizes are not awaited here: the table renders now and each row fills in when its folder scan finishes.
  const rows = accounts.map((entry) => ({ entry, stats: getAccountStats(entry.folder) }));

  return (
    <main className="pt-12 pb-16">
      <LibraryTable rows={rows} now={now} />
    </main>
  );
}
