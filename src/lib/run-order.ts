const CHUNK = /\d+|\D+/g;

function isDigits(chunk: string): boolean {
  return chunk.charCodeAt(0) >= 48 && chunk.charCodeAt(0) <= 57;
}

function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Oldest first, comparing runs of digits as numbers. It never has to guess which part of an id is the
 * folder name and which is the `-N` suffix the allocator adds for a second run in the same second:
 * `...acct-2` comes before `...acct-10` whatever it means, and a folder named `acct-2` simply sorts as
 * the text it is. Every comparison is chunk by chunk, so the order is consistent (transitive).
 */
function naturalCompare(a: string, b: string): number {
  const left = a.match(CHUNK) ?? [];
  const right = b.match(CHUNK) ?? [];
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === y) continue;
    const xDigits = isDigits(x);
    const yDigits = isDigits(y);
    if (xDigits && yDigits) {
      const order = compareDigits(x, y);
      if (order !== 0) return order;
      continue;
    }
    if (xDigits !== yDigits) return xDigits ? -1 : 1;
    return x < y ? -1 : 1;
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Newest first. Run ids are allocated at enqueue time in local time (`2026-11-11T14-30-00_acct`), so
 * the id is chronological. `startedAt` is UTC and queued runs have none, so it cannot be mixed in.
 */
export function compareRunIds(a: string, b: string): number {
  return naturalCompare(b, a);
}
