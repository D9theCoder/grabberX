import { describe, expect, it } from "vitest";
import { compareRunIds } from "@/lib/run-order";

function newestFirst(ids: string[]): string[] {
  return [...ids].sort(compareRunIds);
}

describe("compareRunIds", () => {
  it("puts the newest second first", () => {
    expect(newestFirst(["2026-11-11T09-00-00_a", "2026-11-11T09-00-01_a"])).toEqual([
      "2026-11-11T09-00-01_a",
      "2026-11-11T09-00-00_a",
    ]);
  });

  it("orders the same-second suffixes by number, not as text", () => {
    const base = "2026-11-11T09-00-00_username";
    expect(newestFirst([base, `${base}-2`, `${base}-10`, `${base}-3`])).toEqual([
      `${base}-10`,
      `${base}-3`,
      `${base}-2`,
      base,
    ]);
  });

  it("still orders unrelated folders of one second by their names", () => {
    expect(newestFirst(["2026-11-11T09-00-00_a", "2026-11-11T09-00-00_b"])).toEqual([
      "2026-11-11T09-00-00_b",
      "2026-11-11T09-00-00_a",
    ]);
  });

  it("is a consistent order for ids it cannot tell apart", () => {
    const ids = ["2026-11-11T09-00-00_acct-2", "2026-11-11T09-00-00_acct", "2026-11-11T09-00-00_acct-3"];
    const forward = newestFirst(ids);
    expect(newestFirst([...ids].reverse())).toEqual(forward);
  });
});
