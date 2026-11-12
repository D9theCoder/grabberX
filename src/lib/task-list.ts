import { folderNameFor } from "@/lib/sites";
import { formatSpeed, progressFraction } from "@/lib/progress";
import type { Run, RunStatus, SiteId, Step } from "@/lib/spec";

/** One active run as the top-bar task list shows it. */
export interface TaskSummary {
  id: string;
  folder: string;
  site: SiteId;
  status: Extract<RunStatus, "queued" | "running" | "stopping">;
  step?: Step["label"];
  stepIndex: number;
  steps: number;
  saved: number;
  failed: number;
  /** Live speed, and the estimated percent when the site gave a total; both absent before the first tick. */
  bytesPerSec?: number;
  percent?: number;
  simulate: boolean;
  scheduled: boolean;
  /** 1-based place in the queue; 0 once the run has started. */
  position: number;
  startedAt?: string;
}

export const RUNS_CHANGED_EVENT = "gather-runs-changed";

/** Running runs first (oldest start first), then the queue in the order it will start. */
export function summarizeTasks(runs: Run[], positionOf: (id: string) => number): TaskSummary[] {
  const tasks = runs
    .filter((run): run is Run & { status: TaskSummary["status"] } =>
      run.status === "queued" || run.status === "running" || run.status === "stopping",
    )
    .map((run) => ({
      id: run.id,
      folder: folderNameFor(run.spec),
      site: run.spec.site,
      status: run.status,
      step: run.steps[run.stepIndex]?.label,
      stepIndex: run.stepIndex,
      steps: run.steps.length,
      saved: run.counts.saved,
      failed: run.counts.failed,
      bytesPerSec: run.progress?.bytesPerSec,
      percent: percentOf(run),
      simulate: run.spec.simulate === true,
      scheduled: run.scheduled === true,
      position: run.status === "queued" ? positionOf(run.id) : 0,
      startedAt: run.startedAt,
    }));
  return tasks.sort((a, b) => {
    const aQueued = a.status === "queued";
    const bQueued = b.status === "queued";
    if (aQueued !== bQueued) return aQueued ? 1 : -1;
    if (aQueued) return a.position - b.position;
    return (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
  });
}

const STEP_WORDS: Record<Step["label"], string> = { images: "Images", videos: "Videos", all: "All media" };

/** The quiet detail beside a task's status. */
export function taskDetail(task: TaskSummary): string {
  if (task.status === "queued") return task.position > 0 ? `#${task.position} in line` : "Waiting";
  const parts: string[] = [];
  if (task.step) parts.push(task.steps > 1 ? `${STEP_WORDS[task.step]} ${task.stepIndex + 1}/${task.steps}` : STEP_WORDS[task.step]);
  parts.push(`${task.saved.toLocaleString("en-US")} ${task.simulate ? "found" : "saved"}`);
  if (task.failed > 0) parts.push(`${task.failed.toLocaleString("en-US")} failed`);
  if (task.percent !== undefined) parts.push(`~${task.percent}%`);
  if (task.bytesPerSec) parts.push(formatSpeed(task.bytesPerSec));
  return parts.join(" · ");
}

/** "2 running, 3 queued" for the bubble's label. */
export function taskCountLabel(tasks: TaskSummary[]): string {
  const queued = tasks.filter((task) => task.status === "queued").length;
  const running = tasks.length - queued;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(", ");
}

/** Tells the task bubble to refresh now instead of at its next poll. */
export function notifyRunsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
}

function percentOf(run: Run): number | undefined {
  const fraction = progressFraction(run.progress, false);
  return fraction === null ? undefined : Math.min(99, Math.floor(fraction * 100));
}
