"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";
import type { CommandStep } from "@/components/ui/command-block";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

interface CommandPanelProps {
  steps: CommandStep[];
  /** Why the run buttons are disabled. Null when a run can start. */
  reason: string | null;
  downloadLabel: "Download" | "Queue";
  pending: "preview" | "download" | null;
  error: string | null;
  /** Shown above the buttons while a run for this account waits in the queue. */
  queuedNote: string | null;
  /** Tappable run summary in the sticky bar on narrow screens. */
  barSummary: ReactNode;
  onPreview: () => void;
  onDownload: () => void;
}

export function CommandPanel(props: CommandPanelProps) {
  const [showCommand, setShowCommand] = useState(false);
  const blocked = props.reason !== null;
  const busy = props.pending !== null;
  const single = props.steps.length === 1;

  function scrollToRun() {
    document.getElementById("run-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setShowCommand((value) => !value)}
        aria-expanded={showCommand}
        className="self-start text-small text-ink-2 underline underline-offset-2 hover:text-ink sm:hidden"
      >
        {showCommand ? "Hide command" : "Show command"}
      </button>
      <div className={cn(!showCommand && "max-sm:hidden")}>
        {single ? (
          <CommandBlock label="gallery-dl command" command={props.steps[0].command} />
        ) : (
          <CommandBlock steps={props.steps} />
        )}
      </div>

      <div
        className={cn(
          "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-10 max-lg:border-t max-lg:border-line max-lg:bg-paper",
          "max-lg:px-4 max-lg:py-3 sm:max-lg:px-8",
        )}
      >
        {props.barSummary ? (
          <button
            type="button"
            onClick={scrollToRun}
            className="mb-2 flex w-full items-center justify-between text-left lg:hidden"
          >
            {props.barSummary}
          </button>
        ) : null}
        <div className="mx-auto grid max-w-[1120px] grid-cols-2 gap-2">
          <Button
            variant="secondary"
            disabled={blocked || busy}
            loading={props.pending === "preview"}
            onClick={props.onPreview}
          >
            Preview files
          </Button>
          <Button
            variant="primary"
            disabled={blocked || busy}
            loading={props.pending === "download"}
            title="Ctrl+Enter"
            onClick={props.onDownload}
          >
            {props.downloadLabel}
          </Button>
        </div>
        {props.reason ? <p className="mt-2 mb-0 text-small text-ink-2">{props.reason}</p> : null}
        {props.queuedNote ? <p className="mt-2 mb-0 text-small text-warn">{props.queuedNote}</p> : null}
      </div>

      {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    </div>
  );
}
