import Link from "next/link";
import { DownloadIcon } from "@/components/icons";
import { ForgetButton } from "@/components/mobile/forget-button";
import { MobileOfflineSync } from "@/components/mobile/mobile-offline-sync";
import { listAccounts } from "@/server/library";

export const dynamic = "force-dynamic";

export default async function MobileHomePage() {
  const now = Date.now();
  let accounts: Awaited<ReturnType<typeof listAccounts>> = [];
  let failed = false;
  try {
    accounts = await listAccounts();
  } catch (error) {
    failed = true;
    console.error("grabberX: could not list accounts for the mobile gallery.", error);
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-10">
      <div className="flex items-center justify-between gap-3">
        <h1 className="m-0 text-display">Library</h1>
        <Link
          href="/m/download"
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-label font-medium text-ink transition-colors duration-120 hover:border-ink-2"
        >
          <DownloadIcon className="size-4 flex-none" />
          Download
        </Link>
      </div>
      {failed ? (
        <p className="m-0 text-body text-ink-2">The library couldn&apos;t be read. Check grabberX on the PC.</p>
      ) : accounts.length === 0 ? (
        <p className="m-0 text-body text-ink-2">Nothing downloaded yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line border-y border-line p-0">
          {accounts.map((account) => (
            <li key={account.folder}>
              <Link
                href={`/m/${encodeURIComponent(account.folder)}`}
                className="flex min-h-14 items-center justify-between gap-3 py-2 font-mono text-body"
              >
                <span className="min-w-0 truncate">{account.folder}</span>
                <span aria-hidden className="text-ink-2">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <MobileOfflineSync now={now} />
      <ForgetButton />
    </main>
  );
}
