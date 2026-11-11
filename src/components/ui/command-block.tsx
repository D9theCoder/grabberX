"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface CommandStep {
  label: string;
  command: string;
}

export interface CommandBlockProps {
  command?: string;
  label?: string;
  /** Several steps (Media = All runs images, then videos). */
  steps?: CommandStep[];
  onCopy?: (command: string) => void;
  className?: string;
}

// Flags in ink-2, values in ink: the values are what change between runs.
function highlight(text: string) {
  return text.split(/(\s+)/).map((part, index) =>
    /^-{1,2}[A-Za-z]/.test(part) ? (
      <span key={index} className="text-ink-2">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function CommandBlock({ command = "", label = "Command", steps, onCopy, className }: CommandBlockProps) {
  const list = steps ?? [{ label, command }];
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const current = list[Math.min(tab, list.length - 1)];

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(current.command);
    } catch {
      // Clipboard access can be blocked (insecure context, permissions). The text stays selectable.
    }
    setCopied(true);
    onCopy?.(current.command);
  }

  return (
    <div className={cn("relative overflow-hidden rounded-lg border border-line-strong bg-sunken", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface py-1 pr-1 pl-3.5">
        <div role={list.length > 1 ? "tablist" : undefined} className="flex gap-4 text-small text-ink-2">
          {list.map((step, index) =>
            list.length > 1 ? (
              <button
                key={step.label}
                type="button"
                role="tab"
                aria-selected={index === tab}
                onClick={() => setTab(index)}
                className={cn("h-8 cursor-pointer", index === tab && "font-semibold text-ink")}
              >
                {index + 1} · {step.label}
              </button>
            ) : (
              <span key={step.label} className="h-8 leading-8">
                {step.label}
              </span>
            ),
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy command">
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <span aria-live="polite" className="sr-only">
          {copied ? "Copied" : ""}
        </span>
      </div>
      <pre className="m-0 px-3.5 py-3 font-mono text-code whitespace-pre-wrap text-ink wrap-anywhere">
        {highlight(current.command)}
      </pre>
    </div>
  );
}
