import type { ActionResult, JobSpec } from "@/lib/spec";

/** Validates untrusted input (a Server Action argument) into a JobSpec. */
export function parseJobSpec(_input: unknown): ActionResult<JobSpec> {
  throw new Error("not implemented");
}
