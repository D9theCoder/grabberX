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

  it("gives the same order whatever order the ids arrive in", () => {
    const stamp = "2026-11-11T09-00-00";
    const ids = [
      `${stamp}_a`,
      `${stamp}_a-1x`,
      `${stamp}_a-2`,
      `${stamp}_a-10`,
      `${stamp}_user-2`,
      `${stamp}_user`,
      `${stamp}_a-02`,
    ];
    const expected = newestFirst(ids);
    for (let shift = 0; shift < ids.length; shift += 1) {
      const rotated = [...ids.slice(shift), ...ids.slice(0, shift)];
      expect(newestFirst(rotated)).toEqual(expected);
      expect(newestFirst([...rotated].reverse())).toEqual(expected);
    }
  });

  it("is transitive over every triple", () => {
    const stamp = "2026-11-11T09-00-00";
    const ids = [`${stamp}_a`, `${stamp}_a-1x`, `${stamp}_a-2`, `${stamp}_a-10`, `${stamp}_a-9`, `${stamp}_b-2`];
    for (const a of ids) {
      for (const b of ids) {
        for (const c of ids) {
          if (compareRunIds(a, b) <= 0 && compareRunIds(b, c) <= 0) {
            expect(compareRunIds(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });
});
