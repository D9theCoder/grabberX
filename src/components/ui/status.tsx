import type { ReactNode } from "react";
import { AlertIcon, CheckIcon, ClockIcon, CrossIcon, StopIcon } from "@/components/icons";
import { Spinner } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { RunStatus } from "@/lib/spec";

export interface StatusProps {
  state: RunStatus;
  /** Quiet detail after the word, e.g. "username · 02:14". */
  children?: ReactNode;
  className?: string;
}

const STATUS = {
  queued: { word: "Queued", Icon: ClockIcon },
  running: { word: "Running", Icon: null },
  stopping: { word: "Stopping", Icon: null },
  done: { word: "Done", Icon: CheckIcon },
  failed: { word: "Failed", Icon: CrossIcon },
  stopped: { word: "Stopped", Icon: StopIcon },
  interrupted: { word: "Interrupted", Icon: AlertIcon },
} as const;

export function Status({ state, children, className }: StatusProps) {
  const { word, Icon } = STATUS[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-small font-medium",
        state === "failed" && "text-danger",
        (state === "queued" || state === "stopped" || state === "interrupted") && "text-ink-2",
        className,
      )}
    >
      {Icon ? <Icon strokeWidth={2.25} className="size-3 flex-none" /> : <Spinner />}
      {word}
      {children ? <span className="font-normal text-ink-2">{children}</span> : null}
    </span>
  );
}
