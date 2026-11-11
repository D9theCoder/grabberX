import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: once per view (Download). secondary: the alternative. ghost: low weight. danger: Stop / Cancel. */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  /** Shows a spinner before the label and disables the button; width stays the same. */
  loading?: boolean;
}

const VARIANTS = {
  primary: "bg-ink text-on-ink hover:bg-ink-hover",
  secondary: "bg-surface text-ink border-line-strong hover:border-ink-2",
  ghost: "bg-transparent text-ink hover:bg-sunken",
  danger: "bg-transparent text-danger hover:bg-sunken",
} as const;

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 border border-transparent font-medium whitespace-nowrap",
        "transition-colors duration-120 active:translate-y-px",
        size === "sm"
          ? "h-8 rounded-sm px-3 text-small"
          : "h-10 rounded-md px-4 text-label",
        VARIANTS[variant],
        loading
          ? cn("disabled:cursor-progress", variant === "primary" && "disabled:bg-ink-hover disabled:text-on-ink")
          : "disabled:cursor-not-allowed disabled:border-transparent disabled:bg-sunken disabled:text-ink-3 disabled:active:translate-y-0",
        "[&_svg]:size-3.5 [&_svg]:flex-none",
        className,
      )}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-3 flex-none animate-[spin_800ms_linear_infinite] rounded-full border-[1.5px] border-current border-r-transparent"
    />
  );
}
