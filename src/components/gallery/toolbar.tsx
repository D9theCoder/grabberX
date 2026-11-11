import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ToolbarProps {
  label: string;
  children: ReactNode;
  className?: string;
}

/** A row of icon buttons. Meant for the lightbox ground (`stage`), where controls use `on-ink`. */
export function Toolbar({ label, children, className }: ToolbarProps) {
  return (
    <div role="toolbar" aria-label={label} className={cn("flex items-center gap-1", className)}>
      {children}
    </div>
  );
}

export interface ToolbarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Accessible name and tooltip text. */
  label: string;
  pressed?: boolean;
}

export function ToolbarButton({ label, pressed, className, children, type = "button", ...rest }: ToolbarButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      {...rest}
      className={cn(
        "group relative inline-flex size-11 items-center justify-center rounded-md border border-transparent text-on-ink",
        "transition-colors duration-120 hover:bg-on-ink/15 disabled:cursor-not-allowed disabled:opacity-40",
        "[&_svg]:size-5 [&_svg]:flex-none",
        pressed && "border-on-ink/60 bg-on-ink/15",
        className,
      )}
    >
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full z-10 mt-1 hidden whitespace-nowrap rounded-sm border border-on-ink/30 bg-stage px-2 py-1 text-small text-on-ink group-hover:block group-focus-visible:block"
      >
        {label}
      </span>
    </button>
  );
}
