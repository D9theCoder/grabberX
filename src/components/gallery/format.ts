import type { SiteId } from "@/lib/spec";

/** Filenames are `{tweet_id}_{n}.{ext}`; the id is everything before the first underscore. */
export function postIdOf(name: string): string | null {
  const match = /^(\d{5,25})_\d+\./.exec(name);
  return match?.[1] ?? null;
}

const SNOWFLAKE_EPOCH_MS = BigInt("1288834974657");

/** Post ids are snowflakes: the top bits are milliseconds since a fixed epoch. */
export function postDateOf(id: string): Date | null {
  try {
    const date = new Date(Number((BigInt(id) >> BigInt(22)) + SNOWFLAKE_EPOCH_MS));
    const year = date.getFullYear();
    return Number.isNaN(year) || year < 2006 || year > 2100 ? null : date;
  } catch {
    return null;
  }
}

export function postUrlOf(id: string): string {
  return `https://x.com/i/status/${id}`;
}

export interface PostInfo {
  id: string;
  date: Date | null;
  url: string;
  label: string;
}

/**
 * Extracts post metadata only when the filename matches the account's site, avoiding bogus X Snowflake
 * dates and dead x.com links on Instagram, Pixiv, Reddit, Bluesky, or custom URL downloads.
 */
export function postInfoOf(name: string, site?: SiteId): PostInfo | null {
  if (site === "pixiv") {
    const match = /^(\d{4,12})(?:_p\d+|_\d+)?\./.exec(name);
    const id = match?.[1];
    return id ? { id, date: null, url: `https://www.pixiv.net/artworks/${id}`, label: "Open on Pixiv" } : null;
  }
  if (site && site !== "x") return null;
  const id = postIdOf(name);
  if (!id) return null;
  // When site is unknown (imported folder), require a plausible Twitter Snowflake length (>= 15 digits)
  // and a date not far in the future so short Pixiv/Fapello IDs aren't decoded as 2010 X tweets.
  if (!site && id.length < 15) return null;
  const date = postDateOf(id);
  if (!site && (!date || date.getTime() > Date.now() + 24 * 3600_000)) return null;
  return { id, date, url: postUrlOf(id), label: "Open on X" };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export type SortKey = "newest" | "oldest" | "name";
export type KindFilter = "all" | "image" | "video";

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function sortFiles<T extends { name: string; mtimeMs: number }>(files: readonly T[], sort: SortKey): T[] {
  const copy = [...files];
  if (sort === "name") return copy.sort((a, b) => compareNames(a.name, b.name));
  const direction = sort === "newest" ? -1 : 1;
  // Names start with the post id, which grows with time, so id order is chronological.
  return copy.sort((a, b) => {
    const left = postIdOf(a.name);
    const right = postIdOf(b.name);
    if (left && right && left !== right) return (BigInt(left) < BigInt(right) ? -1 : 1) * direction;
    return (compareNames(a.name, b.name) || a.mtimeMs - b.mtimeMs) * direction;
  });
}
