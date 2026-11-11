import type { JobSpec, Settings, Step } from "@/lib/spec";

export function buildCommand(
  _spec: JobSpec,
  _settings: Pick<Settings, "mediaRoot" | "cookies">,
): Step[] {
  throw new Error("not implemented");
}

export function formatCommand(_argv: string[], _exe?: string): string {
  throw new Error("not implemented");
}
