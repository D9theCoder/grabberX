import type { JobSpec } from "@/lib/spec";

/** Twitter's custom snowflake epoch (2010-11-04T01:42:54.657Z) in Unix milliseconds. */
const TWITTER_EPOCH_MS = BigInt("1288834974657");
const TWITTER_TIMESTAMP_SHIFT = BigInt(22);

/** Instagram's custom snowflake epoch (2011-08-24T21:07:01.721Z) in Unix milliseconds. */
const INSTAGRAM_EPOCH_MS = BigInt("1314220021721");
const INSTAGRAM_TIMESTAMP_SHIFT = BigInt(23);

const ZERO = BigInt(0);

/** Default safety margin when deriving a snowflake floor from a run timestamp (clock skew / pagination). */
export const DEFAULT_SNOWFLAKE_BUFFER_MS = 5 * 60_000;

const TWITTER_ARCHIVE_ENTRY = /^twitter(\d+)_(\d+)_\d+$/;
const INSTAGRAM_ARCHIVE_ENTRY = /^instagram(\d+)$/;
const FAPELLO_ARCHIVE_ENTRY = /^fapello(?:photo|video)_.+_(\d+)$/;
const PIXIV_ARCHIVE_ENTRY = /^pixiv(\d+)(?:_|\.)/;
const DIGITS = /^\d+$/;

/** Sites whose archive keys carry monotonically increasing numeric post IDs usable as a post-level cutoff. */
export type CutoffSite = "x" | "instagram" | "fapello" | "pixiv";

/** Highest post IDs already stored in a folder's gallery-dl archive, kept separate per site. */
export interface ArchiveTip {
  /** X: highest tweet_id among the account's own posts (retweet_id = 0). */
  tweetId?: string;
  /** X: highest timeline id across all stored X posts, using retweet_id when present. */
  timelineId?: string;
  /** Instagram: highest numeric media_id stored in archive.sqlite3. */
  instagramId?: string;
  /** Fapello: highest numeric post id stored in archive.sqlite3. */
  fapelloId?: string;
  /** Pixiv: highest numeric artwork id stored in archive.sqlite3. */
  pixivId?: string;
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

function hostOf(raw: string): string | null {
  try {
    return new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Which post-level numeric cutoff applies to a spec, including pasted profile URLs under site "url". */
export function cutoffSiteOf(spec: Pick<JobSpec, "site" | "account">): CutoffSite | null {
  if (spec.site === "x" || spec.site === "instagram" || spec.site === "pixiv") {
    return spec.site;
  }
  if (spec.site !== "url") return null;
  const host = hostOf(spec.account);
  if (!host) return null;
  if (matchesHost(host, "x.com") || matchesHost(host, "twitter.com")) return "x";
  if (matchesHost(host, "instagram.com")) return "instagram";
  if (matchesHost(host, "fapello.com")) return "fapello";
  if (matchesHost(host, "pixiv.net")) return "pixiv";
  return null;
}

/**
 * Finds the newest stored post IDs across gallery-dl archive keys for all cutoff-capable sites.
 * Uses BigInt because snowflake IDs exceed Number.MAX_SAFE_INTEGER and SQLite text ordering
 * compares digit strings lexicographically rather than numerically.
 */
export function archiveTipFromEntries(entries: Iterable<string>): ArchiveTip | undefined {
  let maxTweet: bigint | undefined;
  let maxTimeline: bigint | undefined;
  let maxInstagram: bigint | undefined;
  let maxFapello: bigint | undefined;
  let maxPixiv: bigint | undefined;

  for (const entry of entries) {
    const tw = parseTwitterArchiveEntry(entry);
    if (tw) {
      if (tw.retweetId === ZERO && (maxTweet === undefined || tw.tweetId > maxTweet)) {
        maxTweet = tw.tweetId;
      }
      const timelineId = tw.retweetId > tw.tweetId ? tw.retweetId : tw.tweetId;
      if (maxTimeline === undefined || timelineId > maxTimeline) {
        maxTimeline = timelineId;
      }
      continue;
    }

    const ig = INSTAGRAM_ARCHIVE_ENTRY.exec(entry);
    if (ig) {
      const id = BigInt(ig[1]!);
      if (maxInstagram === undefined || id > maxInstagram) maxInstagram = id;
      continue;
    }

    const fp = FAPELLO_ARCHIVE_ENTRY.exec(entry);
    if (fp) {
      const id = BigInt(fp[1]!);
      if (maxFapello === undefined || id > maxFapello) maxFapello = id;
      continue;
    }

    const px = PIXIV_ARCHIVE_ENTRY.exec(entry);
    if (px) {
      const id = BigInt(px[1]!);
      if (maxPixiv === undefined || id > maxPixiv) maxPixiv = id;
    }
  }

  if (
    maxTweet === undefined &&
    maxTimeline === undefined &&
    maxInstagram === undefined &&
    maxFapello === undefined &&
    maxPixiv === undefined
  ) {
    return undefined;
  }
  return {
    ...(maxTweet !== undefined ? { tweetId: maxTweet.toString() } : {}),
    ...(maxTimeline !== undefined ? { timelineId: maxTimeline.toString() } : {}),
    ...(maxInstagram !== undefined ? { instagramId: maxInstagram.toString() } : {}),
    ...(maxFapello !== undefined ? { fapelloId: maxFapello.toString() } : {}),
    ...(maxPixiv !== undefined ? { pixivId: maxPixiv.toString() } : {}),
  };
}

/** Backwards-compatible alias for tests that only exercise Twitter entries. */
export const twitterArchiveTip = archiveTipFromEntries;

/** Picks the relevant stored post ID from `tip` for `spec`. */
export function tipForSpec(
  spec: Pick<JobSpec, "site" | "account" | "advanced">,
  tip: ArchiveTip | undefined,
): string | undefined {
  if (!tip) return undefined;
  switch (cutoffSiteOf(spec)) {
    case "x":
      return spec.advanced.retweets ? tip.timelineId : tip.tweetId;
    case "instagram":
      return tip.instagramId;
    case "fapello":
      return tip.fapelloId;
    case "pixiv":
      return tip.pixivId;
    default:
      return undefined;
  }
}

/**
 * gallery-dl flags that stop extraction at the post level as soon as the feed reaches or passes
 * `sincePostId`, before `--filter` discards non-matching media types (such as images during a video pass).
 */
export function postFilterFlagsFor(site: CutoffSite, sincePostId: string): string[] {
  switch (site) {
    case "x":
      return [
        "-o",
        "twitter.pinned=false",
        "--post-filter",
        `int(retweet_id or tweet_id) > ${sincePostId} or abort()`,
      ];
    case "instagram":
      // Skip pinned posts at the top of an Instagram profile instead of aborting on them, and use
      // abort() (not terminate()) so separate profile tabs (e.g. posts and reels) each check new items.
      return [
        "--post-filter",
        `locals().get('pinned') or int(locals().get('post_id') or media_id) > ${sincePostId} or abort()`,
      ];
    case "fapello":
      // Fapello spawns one child post extractor per post, so terminate() stops both child and parent.
      return ["--post-filter", `int(id) > ${sincePostId} or terminate()`];
    case "pixiv":
      return ["--post-filter", `int(id) > ${sincePostId} or abort()`];
  }
}

/**
 * Lower-bound snowflake ID for an ISO timestamp, shifted earlier by `bufferMs` to absorb clock skew.
 * Used as a safe fallback checkpoint when a completed run predates `newestPostId`.
 */
export function snowflakeIdFromIso(
  isoDate: string,
  bufferMs: number = DEFAULT_SNOWFLAKE_BUFFER_MS,
  site: "x" | "instagram" = "x",
): string | undefined {
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return undefined;
  const epoch = site === "instagram" ? INSTAGRAM_EPOCH_MS : TWITTER_EPOCH_MS;
  const shift = site === "instagram" ? INSTAGRAM_TIMESTAMP_SHIFT : TWITTER_TIMESTAMP_SHIFT;
  const elapsed = BigInt(Math.floor(parsed - Math.max(0, bufferMs))) - epoch;
  if (elapsed <= ZERO) return undefined;
  return (elapsed << shift).toString();
}

/** Fallback timestamp-derived cutoff for sites with time-ordered snowflakes (X and Instagram). */
export function checkpointFromIso(
  site: CutoffSite,
  isoDate: string,
  bufferMs: number = DEFAULT_SNOWFLAKE_BUFFER_MS,
): string | undefined {
  if (site === "x" || site === "instagram") {
    return snowflakeIdFromIso(isoDate, bufferMs, site);
  }
  return undefined;
}

/** Returns the smaller (older) of two numeric post ID strings, or whichever one is valid. */
export function minPostId(a: string | undefined, b: string | undefined): string | undefined {
  const left = a && DIGITS.test(a) ? BigInt(a) : undefined;
  const right = b && DIGITS.test(b) ? BigInt(b) : undefined;
  if (left === undefined) return right?.toString();
  if (right === undefined) return left.toString();
  return (left <= right ? left : right).toString();
}
