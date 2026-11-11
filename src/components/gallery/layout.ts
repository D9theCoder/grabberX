export interface Row {
  start: number;
  end: number;
  height: number;
  widths: number[];
  top: number;
}

/**
 * Packs items into rows that fill `width`, each row scaled so every tile keeps its aspect ratio.
 * The last row keeps the target height instead of stretching a few tiles across the page.
 */
export function justify(aspects: readonly number[], width: number, targetHeight: number, gap: number): Row[] {
  const rows: Row[] = [];
  if (width <= 0 || aspects.length === 0) return rows;
  let top = 0;
  let start = 0;
  let sum = 0;
  for (let index = 0; index < aspects.length; index++) {
    sum += aspects[index] ?? 1;
    const count = index - start + 1;
    const natural = sum * targetHeight + gap * (count - 1);
    const isLast = index === aspects.length - 1;
    if (natural >= width || isLast) {
      const stretch = natural >= width;
      const height = stretch ? (width - gap * (count - 1)) / sum : targetHeight;
      const widths = aspects.slice(start, index + 1).map((aspect) => aspect * height);
      rows.push({ start, end: index + 1, height, widths, top });
      top += height + gap;
      start = index + 1;
      sum = 0;
    }
  }
  return rows;
}

function firstRowEndingAfter(rows: readonly Row[], offset: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (row && row.top + row.height < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Rows that intersect [from, to), for rendering only what is near the viewport. */
export function visibleRows(rows: readonly Row[], from: number, to: number): Row[] {
  const out: Row[] = [];
  for (let index = firstRowEndingAfter(rows, from); index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.top > to) break;
    out.push(row);
  }
  return out;
}

export function totalHeight(rows: readonly Row[]): number {
  const last = rows.at(-1);
  return last ? last.top + last.height : 0;
}

export function rowOfIndex(rows: readonly Row[], index: number): Row | undefined {
  return rows.find((row) => index >= row.start && index < row.end);
}

/** The tile in `row` whose horizontal centre is closest to `x`, for the up and down arrow keys. */
export function nearestInRow(row: Row, x: number, gap: number): number {
  let left = 0;
  let best = row.start;
  let bestDistance = Infinity;
  row.widths.forEach((width, offset) => {
    const distance = Math.abs(left + width / 2 - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row.start + offset;
    }
    left += width + gap;
  });
  return best;
}

export function centreOf(row: Row, index: number, gap: number): number {
  let left = 0;
  for (let offset = 0; offset < index - row.start; offset++) left += (row.widths[offset] ?? 0) + gap;
  return left + (row.widths[index - row.start] ?? 0) / 2;
}
