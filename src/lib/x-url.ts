import { validateAccount } from "@/lib/sites";

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

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\)\]]+/gi;
const BARE_X_HOST = /^(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\//i;

export interface ParsedXPost {
  handle: string;
  postId: string;
  canonicalUrl: string;
}

/** Validates a bare or @-prefixed X handle (`^[A-Za-z0-9_]{1,15}$`). */
export function parseXHandle(raw: string): string | null {
  const trimmed = raw.trim();
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return X_HANDLE_PATTERN.test(handle) ? handle : null;
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

/** Extracts the first valid X/Twitter post URL embedded in freeform share text. */
export function extractXPostFromText(raw: string): ParsedXPost | null {
  const matches = raw.match(URL_IN_TEXT);
  if (!matches) return null;
  for (const candidate of matches) {
    const cleaned = candidate.replace(/[.,;:!?)"']+$/, "");
    const parsed = parseXPostUrl(cleaned);
    if (parsed) return parsed;
  }
  return null;
}

export interface ShareParams {
  title?: string;
  text?: string;
  url?: string;
}

/** Android's X app usually shares the post URL inside `text` rather than `url`; scan all share fields. */
export function extractXPostFromShare(params: ShareParams): ParsedXPost | null {
  for (const field of [params.url, params.text, params.title]) {
    if (!field) continue;
    const direct = parseXPostUrl(field);
    if (direct) return direct;
    const embedded = extractXPostFromText(field);
    if (embedded) return embedded;
  }
  return null;
}

/** Fallback for shared X profile links (no `/status/<id>`). */
export function extractXAccountFromShare(params: ShareParams): string | null {
  for (const field of [params.url, params.text, params.title]) {
    if (!field) continue;
    const trimmed = field.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const check = validateAccount("x", trimmed);
      if (check.ok) return check.account;
    }
    const matches = field.match(URL_IN_TEXT);
    if (!matches) continue;
    for (const candidate of matches) {
      const cleaned = candidate.replace(/[.,;:!?)"']+$/, "");
      const check = validateAccount("x", cleaned);
      if (check.ok) return check.account;
    }
  }
  return null;
}

export type InterpretedDownloadInput =
  | { kind: "empty" }
  | { kind: "post"; post: ParsedXPost }
  | { kind: "account"; handle: string }
  | { kind: "invalid" };

/** Classifies a handle, profile URL, or post URL typed/pasted into the mobile Download form. */
export function interpretDownloadInput(raw: string): InterpretedDownloadInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };

  const postCandidate = BARE_X_HOST.test(trimmed) ? `https://${trimmed}` : trimmed;
  const post = parseXPostUrl(postCandidate);
  if (post) return { kind: "post", post };

  const account = validateAccount("x", trimmed);
  if (account.ok) return { kind: "account", handle: account.account };

  return { kind: "invalid" };
}
