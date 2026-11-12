"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { stopRun } from "@/app/actions";
import { ClockIcon } from "@/components/icons";
import { Spinner } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { notifyRunsChanged, RUNS_CHANGED_EVENT, taskCountLabel, taskDetail } from "@/lib/task-list";
import type { TaskSummary } from "@/lib/task-list";

const BUSY_POLL_MS = 2000;
const IDLE_POLL_MS = 5000;

/** Polls the queue: quickly while something runs, slowly otherwise, not at all in a hidden tab. */
function useTasks(): TaskSummary[] {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let again = false;
    let alive = true;
    let last = "[]";

    async function load() {
      if (loading) {
        again = true;
        return;
      }
      clearTimeout(timer);
      loading = true;
      try {
        const response = await fetch("/api/runs", { cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as { tasks: TaskSummary[] };
          const text = JSON.stringify(body.tasks);
          // Same list, same object: the top bar does not re-render every two seconds for nothing.
          if (alive && text !== last) {
            last = text;
            setTasks(body.tasks);
          }
        }
      } catch {
        /* the server restarted or is stopping; try again at the next tick */
      } finally {
        loading = false;
      }
      if (!alive) return;
      if (again) {
        again = false;
        void load();
        return;
      }
      if (document.visibilityState === "visible") {
        timer = setTimeout(load, last === "[]" ? IDLE_POLL_MS : BUSY_POLL_MS);
      }
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onChanged = () => void load();
    void load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(RUNS_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(RUNS_CHANGED_EVENT, onChanged);
    };
  }, []);

  return tasks;
}

function TaskRow({ task, onNavigate }: { task: TaskSummary; onNavigate: () => void }) {
  const [stopping, startStop] = useTransition();
  return (
    <li className="flex items-center gap-2 border-t border-line first:border-t-0">
      <Link
        href={`/history/${encodeURIComponent(task.id)}`}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-2 py-2 transition-colors duration-120 hover:bg-sunken focus-visible:bg-sunken"
      >
        <span className="truncate font-mono text-code text-ink">
          {task.folder}
          {task.simulate ? <span className="font-sans text-small text-ink-2"> · preview</span> : null}
          {task.scheduled ? <span className="font-sans text-small text-ink-2"> · automatic</span> : null}
        </span>
        <Status state={task.status}>{taskDetail(task)}</Status>
      </Link>
      {task.status !== "stopping" ? (
        <button
          type="button"
          disabled={stopping}
          aria-label={`${task.status === "queued" ? "Cancel" : "Stop"} ${task.folder}`}
          onClick={() =>
            startStop(async () => {
              await stopRun(task.id);
              notifyRunsChanged();
            })
          }
          className="mr-1 flex-none rounded-sm px-2 py-1.5 text-small font-medium text-danger transition-colors duration-120 hover:bg-sunken disabled:text-ink-3"
        >
          {task.status === "queued" ? "Cancel" : "Stop"}
        </button>
      ) : null}
    </li>
  );
}

export function TaskBubble() {
  const tasks = useTasks();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (tasks.length === 0 && !open) return null;

  const running = tasks.some((task) => task.status !== "queued");
  const summary = taskCountLabel(tasks);

  return (
    <div ref={root} className="relative flex items-center">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={tasks.length > 0 ? `Tasks: ${summary}` : "Tasks"}
        title={summary || undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-small font-medium tabular-nums transition-colors duration-120",
          open ? "border-ink bg-sunken text-ink" : "border-line-strong text-ink hover:border-ink-2",
        )}
      >
        {running ? <Spinner /> : <ClockIcon strokeWidth={2.25} className="size-3 flex-none" />}
        {tasks.length}
      </button>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label="Tasks"
          className="absolute top-[calc(100%+12px)] right-0 z-50 flex w-[min(22rem,calc(100vw-32px))] flex-col rounded-md border border-line-strong bg-surface p-1 text-ink"
        >
          <div className="flex items-baseline justify-between gap-3 px-2 pt-1.5 pb-1">
            <h2 className="m-0 text-label font-semibold">Tasks</h2>
            <span className="text-small text-ink-2">{summary || "All finished"}</span>
          </div>
          {tasks.length > 0 ? (
            <ul className="m-0 max-h-[min(24rem,60vh)] list-none overflow-y-auto p-0">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} onNavigate={() => setOpen(false)} />
              ))}
            </ul>
          ) : (
            <p className="m-0 px-2 py-3 text-small text-ink-2">Nothing is running or waiting.</p>
          )}
          <Link
            href="/history"
            onClick={() => setOpen(false)}
            className="mt-1 rounded-sm border-t border-line px-2 py-2 text-small text-ink-2 transition-colors duration-120 hover:bg-sunken hover:text-ink"
          >
            Open History
          </Link>
        </div>
      ) : null}
    </div>
  );
}
