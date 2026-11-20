import { access } from "node:fs/promises";
import { RunScreen } from "@/components/run-screen";
import { summarizeTasks } from "@/lib/task-list";
import { runQueue } from "@/server/run-queue";
import { requireSetup } from "@/server/setup";
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
  await requireSetup();
  const { account } = await searchParams;
  const settingsPromise = getSettings();
  const [settings, galleryDlFound] = await Promise.all([
    settingsPromise,
    settingsPromise.then((loaded) => fileExists(loaded.galleryDlPath)),
  ]);
  const activeRun = summarizeTasks(runQueue.list(), (id) => runQueue.queuePosition(id))[0];

  return (
    <RunScreen
      settings={settings}
      galleryDlFound={galleryDlFound}
      initialRunId={activeRun?.id ?? null}
      initialAccount={typeof account === "string" ? account : ""}
    />
  );
}
