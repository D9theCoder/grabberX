import { describe, expect, it } from "vitest";
import { centreOf, justify, nearestInRow, rowOfIndex, totalHeight, visibleRows } from "./layout";

describe("justify", () => {
  it("returns nothing for no items or no width", () => {
    expect(justify([], 800, 200, 4)).toEqual([]);
    expect(justify([1, 1], 0, 200, 4)).toEqual([]);
  });

  it("fills each full row exactly and keeps aspect ratios", () => {
    const rows = justify([1.5, 1.5, 1.5, 1.5, 1.5, 1.5], 900, 200, 4);
    const first = rows[0]!;
    const used = first.widths.reduce((sum, width) => sum + width, 0) + 4 * (first.widths.length - 1);
    expect(used).toBeCloseTo(900, 5);
    first.widths.forEach((width) => expect(width / first.height).toBeCloseTo(1.5, 5));
  });

  it("keeps the last row at the target height", () => {
    const rows = justify([1, 1, 1, 1, 1, 1], 1000, 200, 0);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.height).toBe(200);
    expect(rows[1]!.widths).toEqual([200]);
  });

  it("places rows one under the other with the gap between", () => {
    const rows = justify([1, 1, 1, 1, 1, 1], 400, 200, 10);
    expect(rows[1]!.top).toBeCloseTo(rows[0]!.height + 10, 5);
    expect(totalHeight(rows)).toBeCloseTo(rows.at(-1)!.top + rows.at(-1)!.height, 5);
  });

  it("covers every item exactly once", () => {
    const rows = justify(Array.from({ length: 53 }, (_, index) => 0.6 + (index % 5) * 0.4), 1100, 180, 4);
    expect(rows[0]!.start).toBe(0);
    rows.forEach((row, index) => {
      if (index > 0) expect(row.start).toBe(rows[index - 1]!.end);
    });
    expect(rows.at(-1)!.end).toBe(53);
  });
});

describe("visibleRows", () => {
  const rows = justify(Array.from({ length: 5000 }, () => 1.5), 1000, 200, 4);

  it("returns a small window of a long list", () => {
    const window = visibleRows(rows, 5000, 6200);
    expect(window.length).toBeGreaterThan(0);
    expect(window.length).toBeLessThan(15);
    expect(window[0]!.top + window[0]!.height).toBeGreaterThanOrEqual(5000);
  });

  it("returns nothing past the end", () => {
    expect(visibleRows(rows, totalHeight(rows) + 1000, totalHeight(rows) + 2000)).toEqual([]);
  });
});

describe("keyboard helpers", () => {
  const rows = justify([1, 1, 1, 1, 1, 1, 1, 1], 400, 100, 0);

  it("finds the row of an index", () => {
    expect(rowOfIndex(rows, 5)).toBe(rows.find((row) => row.start <= 5 && row.end > 5));
    expect(rowOfIndex(rows, 99)).toBeUndefined();
  });

  it("moves to the tile under the same x position", () => {
    const first = rows[0]!;
    const second = rows[1]!;
    const x = centreOf(first, first.start + 1, 0);
    expect(nearestInRow(second, x, 0)).toBe(second.start + 1);
  });
});
