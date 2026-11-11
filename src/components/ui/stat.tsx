import { cn } from "@/lib/cn";

export interface StatProps {
  value: number | string;
  label: string;
  tone?: "default" | "muted" | "danger";
  className?: string;
}

export function Stat({ value, label, tone = "default", className }: StatProps) {
  const shown = typeof value === "number" ? value.toLocaleString("en-US") : value;
  return (
    <div role="group" aria-label={`${shown} ${label}`} className={cn("flex flex-col", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "text-stat tabular-nums",
          tone === "muted" && "text-ink-2",
          tone === "danger" && "text-danger",
        )}
      >
        {shown}
      </span>
      <span aria-hidden="true" className="text-small text-ink-2">
        {label}
      </span>
    </div>
  );
}
