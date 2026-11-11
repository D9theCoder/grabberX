import type { ReactNode } from "react";
import { AlertIcon, ClockIcon, InfoIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface NoticeProps {
  tone?: "info" | "warning" | "danger";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

const ICONS = { danger: AlertIcon, warning: ClockIcon, info: InfoIcon } as const;

export function Notice({ tone = "info", title, children, action, className }: NoticeProps) {
  const Icon = ICONS[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 text-label text-ink", className)}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4",
          tone === "info" && "text-ink-2",
          tone === "warning" && "text-warn",
          tone === "danger" && "text-danger",
        )}
      />
      <div>
        {title ? (
          <div className={cn("font-semibold", tone === "warning" && "text-warn", tone === "danger" && "text-danger")}>
            {title}
          </div>
        ) : null}
        {children ? <div className={cn(title && "text-ink-2")}>{children}</div> : null}
        {action ? <div className="mt-1.5">{action}</div> : null}
      </div>
    </div>
  );
}
