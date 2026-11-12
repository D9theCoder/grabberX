"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption {
  value: string;
  label: string;
  tag?: string;
  /** Tooltip, e.g. the file extensions an option covers. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps {
  /** Accessible name of the group. */
  label: string;
  options: Array<SegmentedOption | string>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  size?: "md" | "sm";
  /**
   * Below 640 px, lay the options out as an even grid of this many columns instead of a ragged wrap.
   * Required when the options cannot fit one row on a phone.
   */
  columns?: 2 | 3 | 4;
  className?: string;
}

const GRID_COLUMNS = {
  2: "max-sm:grid-cols-2",
  3: "max-sm:grid-cols-3",
  4: "max-sm:grid-cols-4",
} as const;

export function Segmented({
  label,
  options,
  value,
  defaultValue,
  onChange,
  size = "md",
  columns,
  className,
}: SegmentedProps) {
  const normalized = options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
  const [inner, setInner] = useState(defaultValue ?? normalized[0]?.value);
  const current = value ?? inner;
  const group = useRef<HTMLDivElement>(null);

  function select(next: string) {
    if (value === undefined) setInner(next);
    onChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();

    let next = index;
    for (let tries = 0; tries < normalized.length; tries++) {
      next = (next + step + normalized.length) % normalized.length;
      if (!normalized[next].disabled) break;
    }
    select(normalized[next].value);
    (group.current?.children[next] as HTMLElement | undefined)?.focus();
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={cn(
        // One height for every segmented control (A8), and a taller touch target on phones.
        // From 640 px up the options must fit one row (the Run page e2e test checks the longest set);
        // the wrap is only a guard so nothing is ever clipped. On phones a long set becomes an even grid.
        "flex min-h-control w-fit max-w-full flex-wrap items-center gap-0.5 rounded-md border border-line-strong bg-surface p-0.5 max-sm:min-h-touch",
        columns && `max-sm:grid max-sm:w-full ${GRID_COLUMNS[columns]}`,
        className,
      )}
    >
      {normalized.map((option, index) => {
        const on = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            onClick={() => select(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative inline-flex self-stretch flex-none items-center gap-1.5 rounded-sm font-medium whitespace-nowrap",
              columns && "max-sm:justify-center",
              // Stretch the hit area to a 44px touch target without changing the visual height.
              "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
              "transition-colors duration-120 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-ink-3",
              size === "sm" ? "px-2.5 text-small" : "px-3.5 text-label",
              on ? "bg-ink text-on-ink hover:bg-ink-hover" : "text-ink-2 hover:bg-sunken hover:text-ink",
            )}
          >
            {option.label}
            {option.tag ? <span className="text-xs font-normal">{option.tag}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
