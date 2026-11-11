import Link from "next/link";
import { notFound } from "next/navigation";
import { RunAgainButton } from "@/components/run-again-button";
import { CommandBlock } from "@/components/ui/command-block";
import { LogView } from "@/components/ui/log-view";
import { Notice } from "@/components/ui/notice";
import { Stat } from "@/components/ui/stat";
import { Status } from "@/components/ui/status";
import { formatCommand } from "@/lib/command";
import { formatElapsed } from "@/lib/format";
import { LAYOUT_LABELS } from "@/lib/form-helpers";
import { maskSecrets } from "@/lib/mask";
import { endMessage } from "@/lib/run-copy";
import { folderNameFor } from "@/lib/sites";
import type { Run } from "@/lib/spec";
import { getRun, getSettings, isValidRunId, readLog } from "@/server/store";

export const dynamic = "force-dynamic";

function settingsRows(run: Run): Array<[string, string]> {
  const { spec } = run;
  const rows: Array<[string, string]> = [
    ["Site", spec.site],
    ["Account", spec.account],
    ["Folder", folderNameFor(spec)],
    ["Media", spec.media],
    ["Dates", spec.dateFrom || spec.dateTo ? `${spec.dateFrom ?? "…"} → ${spec.dateTo ?? "…"}` : "All time"],
    ["Layout", LAYOUT_LABELS[spec.layout.kind]],
  ];
  if (spec.simulate) rows.push(["Mode", "Preview files (nothing written)"]);
  return rows;
}

export default async function HistoryDetailPage({ params }: PageProps<"/history/[id]">) {
  const { id } = await params;
  if (!isValidRunId(id)) notFound();

  const [run, settings, log] = await Promise.all([getRun(id), getSettings(), readLog(id)]);
  if (!run) notFound();

  const outcome = endMessage(run, settings.galleryDlPath);
  const lines = maskSecrets(log).split(/\r?\n/).filter(Boolean);
  const elapsed =
    run.startedAt && run.endedAt ? formatElapsed(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : null;

  return (
    <main className="flex flex-col gap-8 pt-12 pb-16">
      <div className="flex flex-col gap-3">
        <Link href="/history" className="self-start text-small text-ink-2 underline underline-offset-2 hover:text-ink">
          Back to history
        </Link>
        <h1 className="m-0 font-mono text-display font-normal">{folderNameFor(run.spec)}</h1>
        <Status state={run.status}>{elapsed ? ` · ${elapsed}` : ""}</Status>
      </div>

      {outcome ? <Notice tone={outcome.tone}>{outcome.text}</Notice> : null}

      <div className="grid max-w-md grid-cols-3 gap-4">
        <Stat value={run.counts.saved} label="saved" />
        <Stat value={run.counts.skipped} label="skipped" tone="muted" />
        <Stat
          value={run.counts.failed}
          label={run.counts.failed > 0 ? "✕ failed" : "failed"}
          tone={run.counts.failed > 0 ? "danger" : "default"}
        />
      </div>

      <section className="flex flex-col gap-3 border-t border-line pt-8">
        <h2 className="m-0 text-title">Settings used</h2>
        <dl className="m-0 grid max-w-xl grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-label">
          {settingsRows(run).map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-ink-2">{term}</dt>
              <dd className="m-0 font-mono text-code break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-8">
        <h2 className="m-0 text-title">Command</h2>
        <CommandBlock
          steps={run.steps.map((step) => ({ label: step.label, command: formatCommand(step.argv) }))}
        />
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-8">
        <h2 className="m-0 text-title">Log</h2>
        {lines.length > 0 ? (
          <LogView lines={lines} maxHeight={560} />
        ) : (
          <p className="m-0 text-small text-ink-2">This run has no log yet.</p>
        )}
      </section>

      <div>
        <RunAgainButton runId={run.id} />
      </div>
    </main>
  );
}
