import { classifyError } from "@/lib/parse-line";
import type { ErrorKind } from "@/lib/spec";

/** Causes that signing in again cannot fix come first; an early generic line must not hide them. */
const PRIORITY: ErrorKind[] = ["diskFull", "notFound", "rateLimit", "auth"];

export function errorKindFor(lines: readonly string[]): ErrorKind {
  const found = new Set<ErrorKind>();
  for (const line of lines) {
    const kind = classifyError(line);
    if (kind) found.add(kind);
  }
  return PRIORITY.find((kind) => found.has(kind)) ?? [...found][0] ?? "unknown";
}
