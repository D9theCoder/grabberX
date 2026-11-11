"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SwitchProps {
  label: string;
  hint?: ReactNode;
  /** Color the hint like a warning the user must read, e.g. "Overwrite existing files". */
  hintTone?: "default" | "danger";
  /** Shows "Changed · Reset" after the hint while the value differs from the default. */
  changed?: boolean;
  onReset?: () => void;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Switch({
  label,
  hint,
  hintTone = "default",
  changed = false,
  onReset,
  checked,
  defaultChecked = false,
  onChange,
  disabled,
  className,
}: SwitchProps) {
  const id = useId();
  const [inner, setInner] = useState(defaultChecked);
  const current = checked ?? inner;

  function toggle() {
    const next = !current;
    if (checked === undefined) setInner(next);
    onChange?.(next);
  }

  return (
    <div className={cn("flex min-h-10 items-start justify-between gap-4 py-2", className)}>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-label text-ink">
          {label}
        </label>
        {hint || changed ? (
          <span className={cn("text-small", hintTone === "danger" ? "text-danger" : "text-ink-2")}>
            {hint}
            {changed ? (
              <>
                {hint ? " " : null}
                <span className="text-ink-2">
                  Changed ·{" "}
                  <button type="button" onClick={onReset} className="underline underline-offset-2 hover:text-ink">
                    Reset
                  </button>
                </span>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={current}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          "relative mt-px h-5 w-9 flex-none cursor-pointer rounded-[10px] border border-control bg-surface p-0",
          "transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-60",
          "after:absolute after:top-0.5 after:left-0.5 after:size-3.5 after:rounded-full after:bg-ink-2 after:transition-transform after:duration-120 after:content-['']",
          "aria-checked:border-ink aria-checked:bg-ink aria-checked:after:translate-x-4 aria-checked:after:bg-on-ink",
        )}
      />
    </div>
  );
}
