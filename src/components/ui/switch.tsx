"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/cn";

export interface SwitchProps {
  label: string;
  hint?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Switch({ label, hint, checked, defaultChecked = false, onChange, disabled, className }: SwitchProps) {
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
        {hint ? <span className="text-small text-ink-2">{hint}</span> : null}
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
