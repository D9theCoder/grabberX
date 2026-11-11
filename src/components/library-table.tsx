"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { updateAccount, updateAll } from "@/app/library/actions";
import { FolderIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/cn";
import { formatBytes, formatCount, formatRelative } from "@/lib/format";
import { LAYOUT_LABELS } from "@/lib/form-helpers";
import type { AccountStats, DetectedLayout, LibraryEntry } from "@/lib/spec";
import { updateAccountMessage, updateAllMessage } from "@/lib/update-messages";

interface Row {
  entry: LibraryEntry;
  stats: Promise<AccountStats>;
}

type SortKey = "lastRun" | "name" | "size";

const LAYOUT_NAMES: Record<DetectedLayout, string> = {
  byType: LAYOUT_LABELS.byType,
  byTypeYear: LAYOUT_LABELS.byTypeYear,
  flat: LAYOUT_LABELS.flat,
  unknown: "Mixed",
};

function compare(sort: SortKey, stats: Record<string, AccountStats>) {
  return (a: Row, b: Row) => {
    if (sort === "name") return a.entry.folder.localeCompare(b.entry.folder);
    if (sort === "size") return (stats[b.entry.folder]?.bytes ?? -1) - (stats[a.entry.folder]?.bytes ?? -1);
    return (b.entry.lastRunAt ?? "").localeCompare(a.entry.lastRunAt ?? "");
  };
}

export function LibraryTable({ rows }: { rows: Row[] }) {
  const [stats, setStats] = useState<Record<string, AccountStats>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("lastRun");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    for (const row of rows) {
      row.stats
        .then((loaded) => {
          if (!cancelled) setStats((current) => ({ ...current, [row.entry.folder]: loaded }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const visible = rows
    .filter((row) => row.entry.folder.toLowerCase().includes(query.trim().toLowerCase()))
    .sort(compare(sort, stats));

  function update(folder: string) {
    setBusy(folder);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await updateAccount(folder);
        setMessage(
          result.ok
            ? updateAccountMessage(folder, result.data)
            : { tone: "danger", text: result.error },
        );
      } catch {
        setMessage({ tone: "danger", text: "The update couldn't be started." });
      } finally {
        setBusy(null);
      }
    });
  }

  function updateEverything() {
    setBusy("*");
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await updateAll();
        setMessage(
          result.ok
            ? updateAllMessage(result.data)
            : { tone: "danger", text: result.error },
        );
      } catch {
        setMessage({ tone: "danger", text: "The updates couldn't be started." });
      } finally {
        setBusy(null);
      }
    });
  }

  function openFolder(folder: string) {
    // A failed open is not worth a message here, but it must not become an unhandled rejection.
    void fetch("/api/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    }).catch(() => undefined);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="m-0 text-display">Library</h1>
        <Button variant="primary" loading={busy === "*"} disabled={rows.length === 0 || busy !== null} onClick={updateEverything}>
          Update all
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-body text-ink-2">No accounts yet. Your first download will show up here.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <TextField
              label="Search"
              className="w-full sm:w-72"
              placeholder="username"
              mono
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Segmented
              label="Sort by"
              size="sm"
              value={sort}
              onChange={(value) => setSort(value as SortKey)}
              options={[
                { value: "lastRun", label: "Last run" },
                { value: "name", label: "Name" },
                { value: "size", label: "Size" },
              ]}
            />
          </div>

          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line-strong text-small text-ink-2">
                  <th className="py-2 pr-4 font-medium">Account</th>
                  <th className="py-2 pr-4 text-right font-medium">Images</th>
                  <th className="py-2 pr-4 text-right font-medium">Videos</th>
                  <th className="py-2 pr-4 text-right font-medium">Size</th>
                  <th className="py-2 pr-4 font-medium">Last run</th>
                  <th className="py-2 pr-4 font-medium">Layout</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ entry }) => {
                  const loaded = stats[entry.folder];
                  return (
                    <tr key={entry.folder} className="border-b border-line">
                      <td className="py-3 pr-4 font-mono text-code">{entry.folder}</td>
                      <td className={cn("py-3 pr-4 text-right text-label tabular-nums", !loaded && "text-ink-3")}>
                        {loaded ? formatCount(loaded.images) : "…"}
                      </td>
                      <td className={cn("py-3 pr-4 text-right text-label tabular-nums", !loaded && "text-ink-3")}>
                        {loaded ? formatCount(loaded.videos) : "…"}
                      </td>
                      <td className={cn("py-3 pr-4 text-right text-label tabular-nums", !loaded && "text-ink-3")}>
                        {loaded ? formatBytes(loaded.bytes) : "…"}
                      </td>
                      <td className="py-3 pr-4 text-small text-ink-2">
                        {entry.lastRunAt ? formatRelative(entry.lastRunAt) : "—"}
                      </td>
                      <td className="py-3 pr-4 text-small text-ink-2">{LAYOUT_NAMES[entry.layout]}</td>
                      <td className="py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy === entry.folder}
                            disabled={busy !== null}
                            onClick={() => update(entry.folder)}
                          >
                            Update
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openFolder(entry.folder)}>
                            <FolderIcon />
                            Open folder
                          </Button>
                          <Link
                            href={`/?account=${encodeURIComponent(entry.folder)}`}
                            className="inline-flex h-8 items-center rounded-sm px-3 text-small font-medium text-ink hover:bg-sunken"
                          >
                            Use as new run
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
