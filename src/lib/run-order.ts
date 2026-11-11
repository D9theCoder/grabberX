const DEDUPE_SUFFIX = /^(.*?)(?:-(\d+))?$/;

function splitId(id: string): { base: string; attempt: number } {
  const match = DEDUPE_SUFFIX.exec(id);
  return { base: match?.[1] ?? id, attempt: match?.[2] ? Number(match[2]) : 1 };
}

/**
 * Newest first. Run ids are allocated at enqueue time in local time (`2026-11-11T14-30-00_acct`), so
 * the id is chronological. `startedAt` is UTC and queued runs have none, so it cannot be mixed in.
 * Two runs of one folder in the same second differ by a numeric `-N` suffix, and `-10` must sort
 * after `-2`, which a plain string comparison gets wrong.
 */
export function compareRunIds(a: string, b: string): number {
  if (a === b) return 0;
  const left = splitId(a);
  const right = splitId(b);
  if (left.base === right.base && left.attempt !== right.attempt) {
    return right.attempt - left.attempt;
  }
  return a < b ? 1 : -1;
}
