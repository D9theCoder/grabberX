import type { RunEvent } from "@/lib/spec";

export function parseLine(_stream: "stdout" | "stderr", _line: string): RunEvent | null {
  throw new Error("not implemented");
}
