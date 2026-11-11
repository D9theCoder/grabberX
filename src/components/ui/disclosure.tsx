import type { ReactNode } from "react";
import { ChevronIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface DisclosureProps {
  title: string;
  /** Quiet text after the title, e.g. "2 changed". */
  meta?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Disclosure({ title, meta, defaultOpen, children, className }: DisclosureProps) {
  return (
    <details open={defaultOpen} className={cn("group border-t border-line", className)}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 text-body font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronIcon
          strokeWidth={2}
          className="size-3.5 flex-none transition-transform duration-200 group-open:rotate-90"
        />
        {title}
        {meta ? <span className="text-small font-normal text-ink-2">{meta}</span> : null}
      </summary>
      <div className="pt-1 pb-4 pl-[22px]">{children}</div>
    </details>
  );
}
