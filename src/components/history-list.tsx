"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { Status } from "@/components/ui/status";
import { TextField } from "@/components/ui/text-field";
import { formatCount, formatElapsed, formatRelative } from "@/lib/format";
import { MEDIA_LABELS } from "@/lib/form-helpers";
import { folderNameFor } from "@/lib/sites";
import type { Run } from "@/lib/spec";

type StatusFilter = "all" | "done" | "failed" | "stopped";

function duration(run: Run): string {
  if (!run.startedAt || !run.endedAt) return "—";
  return formatElapsed(Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

function mediaLabel(run: Run): string {
  return `${MEDIA_LABELS[run.spec.media]}${run.spec.simulate ? " · preview" : ""}`;
}

export function HistoryList({ runs, now }: { runs: Run[]; now: number }) {
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [nowMs, setNowMs] = useState(now);

  // The server's clock is the first frame's clock, so hydration matches; after mount, catch up.
  useEffect(() => {
    setNowMs(Date.now());
  }, [now]);

  const relative = (iso: string) => formatRelative(iso, new Date(nowMs));

  const needle = account.trim().toLowerCase();
  const visible = runs.filter(
    (run) =>
      (status === "all" || run.status === status) &&
      folderNameFor(run.spec).toLowerCase().includes(needle),
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="m-0 text-display">History</h1>

      {runs.length === 0 ? (
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
                      <Status state={run.status} />
                      <span className="text-small text-ink-2">
                        {run.startedAt ? relative(run.startedAt) : "—"}
                      </span>
                    </div>
                    <Link
                      href={`/history/${run.id}`}
                      className="font-mono text-code underline-offset-2 hover:underline"
                    >
                      {folderNameFor(run.spec)}
                    </Link>
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
                      <th className="py-2 text-right font-medium">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((run) => (
                      <tr key={run.id} className="border-b border-line hover:bg-sunken">
                        <td className="py-3 pr-4">
                          <Status state={run.status} />
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
                              ? "py-3 text-right text-label text-danger tabular-nums"
                              : "py-3 text-right text-label tabular-nums"
                          }
                        >
                          {formatCount(run.counts.failed)}
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
