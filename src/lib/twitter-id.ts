/** Twitter's custom snowflake epoch (2010-11-04T01:42:54.657Z) in Unix milliseconds. */
const TWITTER_EPOCH_MS = BigInt("1288834974657");
const SNOWFLAKE_TIMESTAMP_SHIFT = BigInt(22);
const ZERO = BigInt(0);

/** Default safety margin when deriving a snowflake floor from a run timestamp (clock skew / pagination). */
export const DEFAULT_SNOWFLAKE_BUFFER_MS = 5 * 60_000;

const TWITTER_ARCHIVE_ENTRY = /^twitter(\d+)_(\d+)_\d+$/;
const DIGITS = /^\d+$/;

/** Highest post IDs already stored in an X account's gallery-dl archive. */
export interface ArchiveTip {
  /** Highest tweet_id among the account's own posts (retweet_id = 0). */
  tweetId?: string;
  /** Highest timeline id across all stored X posts, using retweet_id when present. */
  timelineId?: string;
}

export interface ParsedTwitterEntry {
  tweetId: bigint;
  retweetId: bigint;
}

/** Parses one gallery-dl Twitter archive key (`twitter{tweet_id}_{retweet_id}_{num}`). */
export function parseTwitterArchiveEntry(entry: string): ParsedTwitterEntry | null {
  const match = TWITTER_ARCHIVE_ENTRY.exec(entry);
  if (!match) return null;
  return {
    tweetId: BigInt(match[1]!),
    retweetId: BigInt(match[2]!),
  };
}

/**
 * Finds the newest stored X post IDs across gallery-dl archive keys. Uses BigInt because X
 * snowflake IDs are 64-bit integers (> Number.MAX_SAFE_INTEGER) and SQLite text ordering
 * compares digit strings lexicographically rather than numerically.
 */
export function twitterArchiveTip(entries: Iterable<string>): ArchiveTip | undefined {
  let maxTweet: bigint | undefined;
  let maxTimeline: bigint | undefined;

  for (const entry of entries) {
    const parsed = parseTwitterArchiveEntry(entry);
    if (!parsed) continue;
    const { tweetId, retweetId } = parsed;
    if (retweetId === ZERO && (maxTweet === undefined || tweetId > maxTweet)) {
      maxTweet = tweetId;
    }
    const timelineId = retweetId > tweetId ? retweetId : tweetId;
    if (maxTimeline === undefined || timelineId > maxTimeline) {
      maxTimeline = timelineId;
    }
  }

  if (maxTweet === undefined && maxTimeline === undefined) return undefined;
  return {
    ...(maxTweet !== undefined ? { tweetId: maxTweet.toString() } : {}),
    ...(maxTimeline !== undefined ? { timelineId: maxTimeline.toString() } : {}),
  };
}

/**
 * Lower-bound Twitter snowflake ID for an ISO timestamp, shifted earlier by `bufferMs` to absorb
 * clock skew. Used as a safe fallback checkpoint when a completed run predates `newestPostId`.
 */
export function snowflakeIdFromIso(
  isoDate: string,
  bufferMs: number = DEFAULT_SNOWFLAKE_BUFFER_MS,
): string | undefined {
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return undefined;
  const elapsed = BigInt(Math.floor(parsed - Math.max(0, bufferMs))) - TWITTER_EPOCH_MS;
  if (elapsed <= ZERO) return undefined;
  return (elapsed << SNOWFLAKE_TIMESTAMP_SHIFT).toString();
}

/** Returns the smaller (older) of two numeric post ID strings, or whichever one is valid. */
export function minPostId(a: string | undefined, b: string | undefined): string | undefined {
  const left = a && DIGITS.test(a) ? BigInt(a) : undefined;
  const right = b && DIGITS.test(b) ? BigInt(b) : undefined;
  if (left === undefined) return right?.toString();
  if (right === undefined) return left.toString();
  return (left <= right ? left : right).toString();
}
