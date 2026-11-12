"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { stopRun } from "@/app/actions";
import { FolderIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { LogView } from "@/components/ui/log-view";
import { Notice } from "@/components/ui/notice";
import { Stat } from "@/components/ui/stat";
import { RunProgressView } from "@/components/run-progress";
import { Status } from "@/components/ui/status";
import type { RunStreamState } from "@/components/run-stream-reducer";
import { useNow } from "@/components/use-now";
import { cn } from "@/lib/cn";
import { formatElapsed, truncateMiddle } from "@/lib/format";
import { endMessage, isActiveStatus } from "@/lib/run-copy";
import { folderNameFor } from "@/lib/sites";

const COLLAPSED_LINES = 6;
const STICK_THRESHOLD_PX = 24;

interface RunPanelProps {
  stream: RunStreamState;
  galleryDlPath: string;
  onRunAgain: () => void;
  runAgainPending: boolean;
  className?: string;
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function RunPanel({ stream, galleryDlPath, onRunAgain, runAgainPending, className }: RunPanelProps) {
  const { run, counts, currentFile, lines, wait, progress } = stream;
  const active = run ? isActiveStatus(run.status) : false;
  const now = useNow(active || Boolean(wait));
  const [expanded, setExpanded] = useState(false);
  const [stopping, startStop] = useTransition();
  const [folderError, setFolderError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const element = logRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines, expanded]);

  if (!run) {
    return (
      <p className={cn("text-small text-ink-2", className)}>
        Runs appear here. Nothing is downloaded until you press Download.
      </p>
    );
  }

  const folder = folderNameFor(run.spec);
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : 0;
  const endedAt = run.endedAt ? Date.parse(run.endedAt) : now;
  const elapsed = startedAt && endedAt ? Math.max(0, endedAt - startedAt) : 0;
  const waitSeconds = wait && now ? Math.max(0, Math.ceil((wait.until - now) / 1000)) : 0;
  const outcome = endMessage(run, galleryDlPath);
  const multiStep = run.steps.length > 1;
  const stepLabel = run.steps[run.stepIndex]?.label;
  const announcement = [
    `${run.status}`,
    multiStep && stepLabel ? `step ${run.stepIndex + 1} of ${run.steps.length}, ${stepLabel}` : "",
    wait ? "rate limited, waiting" : "",
  ]
    .filter(Boolean)
    .join(", ");

  function onLogScroll() {
    const element = logRef.current;
    if (!element) return;
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
  }

  async function openFolder() {
    setFolderError(null);
    try {
      const response = await fetch("/api/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      const result = (await response.json()) as { ok: boolean; error?: string };
      if (!result.ok) setFolderError(result.error ?? "Couldn't open the folder.");
    } catch {
      setFolderError("Couldn't open the folder.");
    }
  }

  return (
    <section aria-label="Current run" className={cn("flex flex-col gap-4", className)}>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <Status state={run.status}>
        {" · "}
        <span className="font-mono text-code">{folder}</span>
        {startedAt ? ` · ${formatElapsed(elapsed)}` : ""}
      </Status>

      <div className="grid grid-cols-3 gap-4">
        <Stat value={counts.saved} label="saved" />
        <Stat value={counts.skipped} label="skipped" tone="muted" />
        <Stat
          value={counts.failed}
          label={counts.failed > 0 ? "✕ failed" : "failed"}
          tone={counts.failed > 0 ? "danger" : "default"}
        />
      </div>

      <RunProgressView progress={progress} active={active} />

      {multiStep && stepLabel ? (
        <p className="text-small text-ink-2">
          Step {run.stepIndex + 1} of {run.steps.length} · {stepLabel}
        </p>
      ) : null}

      {currentFile ? (
        <p title={currentFile} className="m-0 truncate font-mono text-code text-ink">
          {truncateMiddle(currentFile, 44)}
        </p>
      ) : null}

      {wait && active ? (
        <Notice tone="warning">
          Rate limited · retrying in {formatCountdown(waitSeconds)}
          {wait.of > 0 ? ` (${wait.attempt} of ${wait.of})` : ""}
        </Notice>
      ) : null}

      {lines.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <LogView
            ref={logRef}
            lines={lines}
            maxLines={expanded ? undefined : COLLAPSED_LINES}
            maxHeight={expanded ? 320 : undefined}
            onScroll={onLogScroll}
          />
          {lines.length > COLLAPSED_LINES ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex min-h-10 items-center self-start text-small text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              {expanded ? "Show fewer lines" : "Show full log"}
            </button>
          ) : null}
        </div>
      ) : null}

      {outcome ? <Notice tone={outcome.tone}>{outcome.text}</Notice> : null}
      {folderError ? <Notice tone="danger">{folderError}</Notice> : null}

      <div className="flex gap-2">
        {active ? (
          <Button
            variant="danger"
            loading={stopping || run.status === "stopping"}
            disabled={run.status === "stopping"}
            onClick={() => startStop(() => void stopRun(run.id))}
          >
            Stop
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={openFolder}>
              <FolderIcon />
              Open folder
            </Button>
            <Button variant="secondary" loading={runAgainPending} onClick={onRunAgain}>
              Run again
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
