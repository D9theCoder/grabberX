"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/cn";

export interface ChoiceOption {
  value: string;
  label: string;
  detail?: string;
}

export interface ChoiceListProps {
  legend?: string;
  options: ChoiceOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  className?: string;
}

export function ChoiceList({ legend, options, value, defaultValue, onChange, className }: ChoiceListProps) {
  const name = useId();
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;

  function select(next: string) {
    if (value === undefined) setInner(next);
    onChange?.(next);
  }

  return (
    <fieldset className={cn("m-0 min-w-0 border-0 p-0", className)}>
      {legend ? <legend className="mb-1 text-label text-ink">{legend}</legend> : null}
      {options.map((option) => {
        const on = option.value === current;
        return (
          <label
            key={option.value}
            className="group grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] gap-x-3 border-t border-line py-3 last:border-b"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={on}
              onChange={() => select(option.value)}
              className={cn(
                "mt-[3px] size-4 cursor-pointer appearance-none rounded-full border-[1.5px] border-control bg-surface",
                "transition-colors duration-120 group-hover:border-ink-2",
                "checked:border-ink checked:bg-ink checked:shadow-[inset_0_0_0_3px_var(--color-surface)]",
              )}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={cn("text-label", on && "font-semibold")}>{option.label}</span>
              {option.detail ? (
                <span title={option.detail} className="truncate font-mono text-small text-ink-2">
                  {option.detail}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
