"use client";

import Link from "next/link";
import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { Status } from "@/components/ui/status";
import { TextField } from "@/components/ui/text-field";
import { formatCount, formatElapsed, formatRelative } from "@/lib/format";
import { folderNameFor } from "@/lib/sites";
import type { Run } from "@/lib/spec";

type StatusFilter = "all" | "done" | "failed" | "stopped";

const MEDIA_LABEL = { images: "Images", videos: "Videos", all: "All" } as const;

function duration(run: Run): string {
  if (!run.startedAt || !run.endedAt) return "—";
  return formatElapsed(Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

export function HistoryList({ runs }: { runs: Run[] }) {
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
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
                      <td className="py-3 pr-4 text-small text-ink-2">
                        {MEDIA_LABEL[run.spec.media]}
                        {run.spec.simulate ? " · preview" : ""}
                      </td>
                      <td
                        className="py-3 pr-4 text-small text-ink-2"
                        title={run.startedAt ? new Date(run.startedAt).toLocaleString("en-US") : undefined}
                      >
                        {run.startedAt ? formatRelative(run.startedAt) : "—"}
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
          )}
        </>
      )}
    </div>
  );
}
