import type { HTMLAttributes, Ref } from "react";
import { cn } from "@/lib/cn";

export interface LogLine {
  text: string;
  level?: "info" | "skip" | "warning" | "error";
}

export interface LogViewProps extends Omit<HTMLAttributes<HTMLPreElement>, "children"> {
  /** Strings are classified: "# " = skip, "[x][warning]" = warning, "[x][error]" = error. */
  lines: Array<LogLine | string>;
  maxLines?: number;
  maxHeight?: number | string;
  label?: string;
  ref?: Ref<HTMLPreElement>;
}

function levelOf(line: LogLine): NonNullable<LogLine["level"]> {
  if (line.level) return line.level;
  if (line.text.startsWith("# ")) return "skip";
  if (/\]\[error\]/.test(line.text)) return "error";
  if (/\]\[warning\]/.test(line.text)) return "warning";
  return "info";
}

const LEVEL_CLASS = {
  info: "",
  skip: "text-ink-2",
  warning: "text-warn",
  error: "text-danger",
} as const;

export function LogView({
  lines,
  maxLines,
  maxHeight,
  label = "Run log",
  className,
  style,
  ref,
  ...rest
}: LogViewProps) {
  const normalized = lines.map((line) => (typeof line === "string" ? { text: line } : line));
  const visible = maxLines ? normalized.slice(-maxLines) : normalized;

  return (
    <pre
      ref={ref}
      role="log"
      aria-label={label}
      style={maxHeight ? { ...style, maxHeight } : style}
      className={cn(
        "m-0 overflow-auto rounded-md bg-sunken px-3 py-2.5 font-mono text-log whitespace-pre text-ink",
        className,
      )}
      {...rest}
    >
      {visible.map((line, index) => (
        <span
          key={index}
          className={cn(
            "block [contain-intrinsic-size:auto_18px] [content-visibility:auto]",
            LEVEL_CLASS[levelOf(line)],
          )}
        >
          {line.text}
        </span>
      ))}
    </pre>
  );
}
