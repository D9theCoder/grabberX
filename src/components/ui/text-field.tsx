import { useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label: string;
  /** Quiet qualifier after the label, e.g. "beta" for the site being typed into. */
  tag?: string;
  hint?: ReactNode;
  /** Replaces the hint and turns the border danger. */
  error?: string;
  /** Fixed text before the input, e.g. "@". */
  prefix?: string;
  /** Use the mono family (handles, paths, sizes like 2M). */
  mono?: boolean;
}

export function TextField({
  label,
  tag,
  hint,
  error,
  prefix,
  mono,
  className,
  id,
  disabled,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = `${fieldId}-hint`;
  const message = error ?? hint;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={fieldId} className="text-label text-ink">
        {label}
        {tag ? <span className="ml-1.5 text-xs text-ink-2">{tag}</span> : null}
      </label>
      <div
        className={cn(
          "flex h-10 items-center rounded-md border bg-surface transition-[border-color,box-shadow] duration-120",
          error
            ? "border-danger focus-within:shadow-[0_0_0_1px_var(--color-danger)]"
            : "border-control hover:border-ink-2 focus-within:border-ink focus-within:shadow-[0_0_0_1px_var(--color-ink)]",
          disabled && "border-transparent bg-sunken hover:border-transparent",
          mono && "font-mono text-code",
        )}
      >
        {prefix ? (
          <span aria-hidden="true" className="-mr-2 pl-3 font-mono text-code text-ink-2">
            {prefix}
          </span>
        ) : null}
        <input
          id={fieldId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? hintId : undefined}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent px-3 text-label text-ink outline-none",
            "placeholder:text-ink-2 disabled:cursor-not-allowed disabled:text-ink-3",
            mono && "font-mono text-code",
          )}
          {...rest}
        />
      </div>
      {message ? (
        <div id={hintId} className={cn("text-small", error ? "text-danger" : "text-ink-2")}>
          {message}
        </div>
      ) : null}
    </div>
  );
}
