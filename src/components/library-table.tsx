"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { pausedAccountList, setAccountPausedAction } from "@/app/actions";
import { moveAccount, updateAccount, updateAll } from "@/app/library/actions";
import { FolderIcon, MoreIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/cn";
import { formatBytes, formatCount, formatRelative } from "@/lib/format";
import { LAYOUT_LABELS } from "@/lib/form-helpers";
import type { AccountStats, DetectedLayout, LibraryEntry } from "@/lib/spec";
import {
  isUnchangedFolderName,
  moveAccountMessage,
  updateAccountMessage,
  updateAllMessage,
} from "@/lib/update-messages";

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

const MENU_WIDTH = 176;

interface RowAction {
  label: string;
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
}

/** The overflow menu sits in the top layer: the table's scroll container would clip an absolute panel. */
function RowMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function toggle() {
    if (open) {
      setPosition(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = actions.length * 40 + 8;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    const top = rect.bottom + height + 4 > window.innerHeight ? rect.top - height - 4 : rect.bottom + 4;
    setPosition({ top, left });
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="inline-flex size-10 items-center justify-center rounded-sm text-ink hover:bg-sunken"
      >
        <MoreIcon strokeWidth={2.5} className="size-3.5" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          style={{ top: position.top, left: position.left, width: MENU_WIDTH }}
          className="fixed z-30 rounded-md border border-line-strong bg-surface py-1"
        >
          {actions.map((action) =>
            action.href ? (
              <Link
                key={action.label}
                href={action.href}
                role="menuitem"
                onClick={() => setPosition(null)}
                className="flex h-10 items-center px-3 text-label text-ink hover:bg-sunken"
              >
                {action.label}
              </Link>
            ) : (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  setPosition(null);
                  action.onSelect?.();
                }}
                className="flex h-10 w-full items-center px-3 text-left text-label text-ink hover:bg-sunken disabled:cursor-not-allowed disabled:text-ink-3"
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

function compare(sort: SortKey, stats: Record<string, AccountStats>) {
  return (a: Row, b: Row) => {
    if (sort === "name") return a.entry.folder.localeCompare(b.entry.folder);
    if (sort === "size") return (stats[b.entry.folder]?.bytes ?? -1) - (stats[a.entry.folder]?.bytes ?? -1);
    return (b.entry.lastRunAt ?? "").localeCompare(a.entry.lastRunAt ?? "");
  };
}

export function LibraryTable({ rows, now }: { rows: Row[]; now: number }) {
  const [stats, setStats] = useState<Record<string, AccountStats>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("lastRun");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [moveName, setMoveName] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);
  const [paused, setPaused] = useState<string[] | null>(null);
  const [nowMs, setNowMs] = useState(now);
  const [, startTransition] = useTransition();

  // The scheduler's account pauses live in the settings. One read for the whole table, before the
  // row toggles mean anything.
  useEffect(() => {
    let cancelled = false;
    pausedAccountList()
      .then((list) => {
        if (!cancelled) setPaused(list);
      })
      .catch(() => {
        if (!cancelled) setPaused([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isPaused = (folder: string) =>
    (paused ?? []).some((name) => name.toLowerCase() === folder.toLowerCase());

  function togglePause(folder: string) {
    const next = !isPaused(folder);
    startTransition(async () => {
      try {
        const result = await setAccountPausedAction({ folder, paused: next });
        if (result.ok) setPaused(result.data);
        else setMessage({ tone: "danger", text: result.error });
      } catch {
        setMessage({ tone: "danger", text: "That account's pause couldn't be changed." });
      }
    });
  }

  // The server's clock is the first frame's clock, so hydration matches; after mount, catch up.
  useEffect(() => {
    setNowMs(Date.now());
  }, [now]);

  const relative = (iso: string) => formatRelative(iso, new Date(nowMs));

  useEffect(() => {
    let cancelled = false;
    for (const row of rows) {
      // A promise passed from a Server Component arrives as a Flight thenable whose `then` returns
      // undefined, so chaining onto it directly throws; Promise.resolve gives back a real promise.
      Promise.resolve(row.stats)
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

  function startMove(folder: string) {
    setMoveFor(folder);
    setMoveName(folder);
    setMoveError(null);
  }

  function cancelMove() {
    setMoveFor(null);
    setMoveError(null);
  }

  function submitMove(folder: string) {
    const target = moveName.trim();
    // The server re-checks everything; these two only save a round trip.
    if (target === "") {
      setMoveError("Enter a folder name.");
      return;
    }
    if (isUnchangedFolderName(folder, target)) {
      setMoveError("That's already this folder's name.");
      return;
    }
    setBusy(`move:${folder}`);
    setMoveError(null);
    startTransition(async () => {
      try {
        const result = await moveAccount(folder, target);
        if (result.ok) {
          setMoveFor(null);
          setMessage(moveAccountMessage(folder, result.data.folder));
        } else {
          setMoveError(result.error);
        }
      } catch {
        setMoveError("The folder couldn't be moved.");
      } finally {
        setBusy(null);
      }
    });
  }

  /** The rename form, shown inline under the row it belongs to, sharing one draft state. */
  function moveEditor(folder: string) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitMove(folder);
        }}
        onReset={(event) => {
          event.preventDefault();
          cancelMove();
        }}
        className="flex flex-wrap items-end gap-3 py-1"
      >
        <TextField
          label="New folder name"
          className="w-full sm:w-72"
          mono
          value={moveName}
          error={moveError ?? undefined}
          hint={
            moveError
              ? undefined
              : "Files and the download archive move with it, so nothing re-downloads."
          }
          disabled={busy !== null}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setMoveName(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          loading={busy === `move:${folder}`}
          disabled={busy !== null}
        >
          Move
        </Button>
        <Button type="reset" size="sm" variant="ghost" disabled={busy !== null}>
          Cancel
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="m-0 text-display">Library</h1>
        <Button variant="secondary" loading={busy === "*"} disabled={rows.length === 0 || busy !== null} onClick={updateEverything}>
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

          {/* Below md the table cannot show every column, so each account becomes a stacked row. */}
          <div className="md:hidden">
            {visible.map(({ entry }) => {
              const loaded = stats[entry.folder];
              return (
                <div key={entry.folder} className="flex flex-col gap-2 border-b border-line py-4">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-mono text-code">{entry.folder}</span>
                    <RowMenu
                      label={`Actions for ${entry.folder}`}
                      actions={[
                        {
                          label: isPaused(entry.folder) ? "Resume updates" : "Pause updates",
                          disabled: busy !== null || paused === null,
                          onSelect: () => togglePause(entry.folder),
                        },
                        { label: "Update", disabled: busy !== null, onSelect: () => update(entry.folder) },
                        { label: "Open folder", onSelect: () => openFolder(entry.folder) },
                        { label: "Move", disabled: busy !== null, onSelect: () => startMove(entry.folder) },
                        {
                          label: "Use as new run",
                          href: `/?account=${encodeURIComponent(entry.folder)}`,
                        },
                      ]}
                    />
                  </div>
                  <dl className="m-0 grid grid-cols-3 gap-2">
                    <div>
                      <dt className="text-small text-ink-2">Images</dt>
                      <dd className={cn("m-0 text-label tabular-nums", !loaded && "text-ink-3")}>
                        {loaded ? formatCount(loaded.images) : "…"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-small text-ink-2">Videos</dt>
                      <dd className={cn("m-0 text-label tabular-nums", !loaded && "text-ink-3")}>
                        {loaded ? formatCount(loaded.videos) : "…"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-small text-ink-2">Size</dt>
                      <dd className={cn("m-0 text-label tabular-nums", !loaded && "text-ink-3")}>
                        {loaded ? formatBytes(loaded.bytes) : "…"}
                      </dd>
                    </div>
                  </dl>
                  {moveFor === entry.folder ? moveEditor(entry.folder) : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-small text-ink-2">
                    <span>{entry.lastRunAt ? `Last run ${relative(entry.lastRunAt)}` : "No runs yet"}</span>
                    <span>{LAYOUT_NAMES[entry.layout]}</span>
                    {isPaused(entry.folder) ? <span>Updates paused</span> : null}
                    {busy === entry.folder ? <span className="text-warn">Starting…</span> : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[680px] border-collapse text-left">
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
                    <Fragment key={entry.folder}>
                      <tr className="border-b border-line">
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
                          {entry.lastRunAt ? relative(entry.lastRunAt) : "—"}
                        </td>
                        <td className="py-3 pr-4 text-small text-ink-2">{LAYOUT_NAMES[entry.layout]}</td>
                        <td className="py-3">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Automatic updates for ${entry.folder}`}
                              aria-pressed={isPaused(entry.folder)}
                              disabled={paused === null || busy !== null}
                              onClick={() => togglePause(entry.folder)}
                            >
                              {isPaused(entry.folder) ? "Paused" : "Pause"}
                            </Button>
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
                            <RowMenu
                              label={`More actions for ${entry.folder}`}
                              actions={[
                                {
                                  label: "Move",
                                  disabled: busy !== null,
                                  onSelect: () => startMove(entry.folder),
                                },
                                {
                                  label: "Use as new run",
                                  href: `/?account=${encodeURIComponent(entry.folder)}`,
                                },
                              ]}
                            />
                          </div>
                        </td>
                      </tr>
                      {moveFor === entry.folder ? (
                        <tr>
                          <td colSpan={7} className="border-b border-line bg-sunken px-4 py-2">
                            {moveEditor(entry.folder)}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
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
