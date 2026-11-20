"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { clearHistoryAction, deleteRunAction, retryFailedRunsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { Status } from "@/components/ui/status";
import { TextField } from "@/components/ui/text-field";
import { formatCount, formatElapsed, formatRelative } from "@/lib/format";
import { MEDIA_LABELS } from "@/lib/form-helpers";
import { isActiveStatus } from "@/lib/run-copy";
import { folderNameFor } from "@/lib/sites";
import type { Run } from "@/lib/spec";
import { notifyRunsChanged } from "@/lib/task-list";

type StatusFilter = "all" | "done" | "failed" | "auth" | "stopped";

function duration(run: Run): string {
  if (!run.startedAt || !run.endedAt) return "—";
  return formatElapsed(Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

function mediaLabel(run: Run): string {
  return `${MEDIA_LABELS[run.spec.media]}${run.spec.simulate ? " · preview" : ""}`;
}

export function HistoryList({ runs, now }: { runs: Run[]; now: number }) {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [nowMs, setNowMs] = useState(now);
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [busy, startTransition] = useTransition();

  // The server's clock is the first frame's clock, so hydration matches; after mount, catch up.
  useEffect(() => {
    setNowMs(Date.now());
  }, [now]);

  const relative = (iso: string) => formatRelative(iso, new Date(nowMs));

  const remainingRuns = runs.filter((run) => !removedIds.has(run.id));
  const needle = account.trim().toLowerCase();
  const visible = remainingRuns.filter((run) => {
    const matchesStatus =
      status === "all" ||
      (status === "auth" ? run.status === "failed" && run.errorKind === "auth" : run.status === status);
    return matchesStatus && folderNameFor(run.spec).toLowerCase().includes(needle);
  });

  const failedVisible = visible.filter((run) => run.status === "failed");
  const failedUniqueAccounts = new Set(failedVisible.map((run) => folderNameFor(run.spec).toLowerCase())).size;
  const hasFinished = remainingRuns.some((run) => !isActiveStatus(run.status));
  const hasAuthFailures = remainingRuns.some((run) => run.status === "failed" && run.errorKind === "auth");

  function retryFailed() {
    setMessage(null);
    const ids = failedVisible.map((run) => run.id);
    startTransition(async () => {
      const result = await retryFailedRunsAction(ids);
      if (result.ok) {
        if (result.data.started > 0) notifyRunsChanged();
        const skippedNote = result.data.skipped > 0 ? ` (${result.data.skipped} already active or skipped)` : "";
        setMessage({
          tone: "info",
          text:
            result.data.started === 0
              ? `No failed accounts needed queuing${skippedNote}.`
              : `Queued ${formatCount(result.data.started)} failed ${result.data.started === 1 ? "account" : "accounts"} for retry${skippedNote}.`,
        });
      } else {
        setMessage({ tone: "danger", text: result.error });
      }
    });
  }

  function removeOne(id: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteRunAction(id);
      if (result.ok) {
        setRemovedIds((current) => new Set(current).add(id));
      } else {
        setMessage({ tone: "danger", text: result.error });
      }
    });
  }

  function clearHistory() {
    setMessage(null);
    startTransition(async () => {
      const result = await clearHistoryAction();
      setConfirmClear(false);
      if (result.ok) {
        setRemovedIds(new Set(runs.filter((run) => !isActiveStatus(run.status)).map((run) => run.id)));
        setMessage({
          tone: "info",
          text:
            result.data.removed === 0
              ? "No finished runs to clear."
              : `Cleared ${formatCount(result.data.removed)} ${result.data.removed === 1 ? "run" : "runs"} from history. Downloaded files were untouched.`,
        });
        router.refresh();
      } else {
        setMessage({ tone: "danger", text: result.error });
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="m-0 text-display">History</h1>
        {remainingRuns.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {failedUniqueAccounts > 0 ? (
              <Button variant="secondary" size="sm" loading={busy} onClick={retryFailed}>
                Retry failed ({formatCount(failedUniqueAccounts)})
              </Button>
            ) : null}
            {hasFinished ? (
              confirmClear ? (
                <>
                  <Button variant="danger" size="sm" loading={busy} onClick={clearHistory}>
                    Confirm clear
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmClear(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmClear(true)}>
                  Clear history
                </Button>
              )
            ) : null}
          </div>
        ) : null}
      </div>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {remainingRuns.length === 0 ? (
        <p className="text-body text-ink-2">No runs yet. Finished runs and their logs show up here.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <TextField
              label="Account"
              mono
              className="w-full sm:w-72"
              placeholder="username"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
            />
            <Segmented
              label="Status"
              size="sm"
              value={status}
              onChange={(value) => setStatus(value as StatusFilter)}
              options={[
                { value: "all", label: "All" },
                { value: "done", label: "Done" },
                { value: "failed", label: "Failed" },
                ...(hasAuthFailures ? [{ value: "auth", label: "Sign-in" }] : []),
                { value: "stopped", label: "Stopped" },
              ]}
            />
          </div>

          {visible.length === 0 ? (
            <p className="text-body text-ink-2">No runs match these filters.</p>
          ) : (
            <>
              {/* Below md the table cannot keep every column readable, so each run becomes one line of facts. */}
              <div className="md:hidden">
                {visible.map((run) => (
                  <div key={run.id} className="flex flex-col gap-1.5 border-b border-line py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-baseline gap-2">
                        <Status state={run.status} />
                        {run.scheduled ? <span className="text-small text-ink-2">Scheduled</span> : null}
                      </div>
                      <span className="text-small text-ink-2">
                        {run.startedAt ? relative(run.startedAt) : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/history/${run.id}`}
                        className="font-mono text-code underline-offset-2 hover:underline"
                      >
                        {folderNameFor(run.spec)}
                      </Link>
                      {!isActiveStatus(run.status) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => removeOne(run.id)}
                          className="text-small text-ink-2 hover:text-danger disabled:text-ink-3"
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-small text-ink-2">
                      <span>
                        {run.spec.media === "all" ? "All media" : MEDIA_LABELS[run.spec.media]}
                        {run.spec.simulate ? " · preview" : ""}
                      </span>
                      <span>{duration(run)}</span>
                      <span>{formatCount(run.counts.saved)} saved</span>
                      <span>{formatCount(run.counts.skipped)} skipped</span>
                      <span className={run.counts.failed > 0 ? "text-danger" : undefined}>
                        {formatCount(run.counts.failed)} failed
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[680px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-line-strong text-small text-ink-2">
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Account</th>
                      <th className="py-2 pr-4 font-medium">Media</th>
                      <th className="py-2 pr-4 font-medium">Started</th>
                      <th className="py-2 pr-4 text-right font-medium">Duration</th>
                      <th className="py-2 pr-4 text-right font-medium">Saved</th>
                      <th className="py-2 pr-4 text-right font-medium">Skipped</th>
                      <th className="py-2 pr-3 text-right font-medium">Failed</th>
                      <th className="py-2 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((run) => (
                      <tr key={run.id} className="border-b border-line hover:bg-sunken">
                        <td className="py-3 pr-4">
                          <span className="flex items-baseline gap-2">
                            <Status state={run.status} />
                            {run.scheduled ? <span className="text-small text-ink-2">Scheduled</span> : null}
                          </span>
                        </td>
                        <td className="py-3 pr-4 font-mono text-code">
                          <Link href={`/history/${run.id}`} className="underline-offset-2 hover:underline">
                            {folderNameFor(run.spec)}
                          </Link>
                        </td>
                        <td className="py-3 pr-4 text-small text-ink-2">{mediaLabel(run)}</td>
                        <td
                          className="py-3 pr-4 text-small text-ink-2"
                          title={run.startedAt ? new Date(run.startedAt).toLocaleString("en-US") : undefined}
                        >
                          {run.startedAt ? relative(run.startedAt) : "—"}
                        </td>
                        <td className="py-3 pr-4 text-right text-label tabular-nums">{duration(run)}</td>
                        <td className="py-3 pr-4 text-right text-label tabular-nums">{formatCount(run.counts.saved)}</td>
                        <td className="py-3 pr-4 text-right text-label text-ink-2 tabular-nums">
                          {formatCount(run.counts.skipped)}
                        </td>
                        <td
                          className={
                            run.counts.failed > 0
                              ? "py-3 pr-3 text-right text-label text-danger tabular-nums"
                              : "py-3 pr-3 text-right text-label tabular-nums"
                          }
                        >
                          {formatCount(run.counts.failed)}
                        </td>
                        <td className="py-3 text-right">
                          {!isActiveStatus(run.status) ? (
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`Delete run for ${folderNameFor(run.spec)}`}
                              onClick={() => removeOne(run.id)}
                              className="rounded-sm px-2 py-1 text-small text-ink-2 transition-colors duration-120 hover:bg-surface hover:text-danger disabled:text-ink-3"
                            >
                              Delete
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
