import { access } from "node:fs/promises";
import { RunScreen } from "@/components/run-screen";
import { isActiveStatus } from "@/lib/run-copy";
import { listAccounts } from "@/server/library";
import { runQueue } from "@/server/run-queue";
import { getSettings } from "@/server/store";

// Settings and the active run change between requests; without this Next would prerender the page at build time.
export const dynamic = "force-dynamic";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default async function RunPage({ searchParams }: PageProps<"/">) {
  const { account } = await searchParams;
  const settingsPromise = getSettings();
  const [settings, accounts, galleryDlFound] = await Promise.all([
    settingsPromise,
    listAccounts(),
    settingsPromise.then((loaded) => fileExists(loaded.galleryDlPath)),
  ]);
  const activeRun = runQueue.list().find((run) => isActiveStatus(run.status));

  return (
    <RunScreen
      settings={settings}
      knownAccounts={accounts.map((entry) => entry.folder)}
      galleryDlFound={galleryDlFound}
      initialRunId={activeRun?.id ?? null}
      initialAccount={typeof account === "string" ? account : ""}
    />
  );
}
