export const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
export const X_POST_ID_PATTERN = /^\d{1,30}$/;

const X_STATUS_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "m.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
]);

export interface ParsedXPost {
  handle: string;
  postId: string;
  canonicalUrl: string;
}

/**
 * Strictly parses an X/Twitter post URL (`https://x.com/<handle>/status/<id>`) and rebuilds the
 * canonical `https://x.com/<handle>/status/<id>` URL from the validated handle and numeric id.
 */
export function parseXPostUrl(raw: string): ParsedXPost | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  if (!X_STATUS_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  const [handle, segment, postId] = segments;
  if (segment.toLowerCase() !== "status") return null;
  if (!X_HANDLE_PATTERN.test(handle) || handle.toLowerCase() === "i") return null;
  if (!X_POST_ID_PATTERN.test(postId)) return null;

  return {
    handle,
    postId,
    canonicalUrl: `https://x.com/${handle}/status/${postId}`,
  };
}

export interface ShareParams {
  title?: string;
  text?: string;
  url?: string;
}
