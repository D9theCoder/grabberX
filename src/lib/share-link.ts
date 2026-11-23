import { siteForUrl, validateAccount } from "@/lib/sites";
import type { SiteId } from "@/lib/spec";
import { parseXPostUrl } from "@/lib/x-url";
import type { ParsedXPost, ShareParams } from "@/lib/x-url";

export interface SharedLink {
  url: string;
  /** The named site the link belongs to, or null for any other page (downloaded as "Other URL"). */
  site: { id: Exclude<SiteId, "url">; label: string } | null;
  /** The profile behind the link, when the site's rules can read one from it. */
  account: string | null;
  /** Set for an X post link, which can be downloaded on its own. */
  post: ParsedXPost | null;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[).,;:!?\]}»”’]+$/;

function urlsIn(value: string | undefined): string[] {
  if (!value) return [];
  const found: string[] = [];
  for (const match of value.matchAll(URL_IN_TEXT)) {
    try {
      const parsed = new URL(match[0].replace(TRAILING_PUNCTUATION, ""));
      if (parsed.protocol === "http:" || parsed.protocol === "https:") found.push(parsed.toString());
    } catch {
      // Not a usable link; keep looking.
    }
  }
  return found;
}

function linkInfo(url: string): SharedLink {
  const def = siteForUrl(url);
  const site = def && def.id !== "url" ? { id: def.id as Exclude<SiteId, "url">, label: def.label } : null;
  const validated = site ? validateAccount(site.id, url) : null;
  return {
    url,
    site,
    account: validated?.ok ? validated.account : null,
    post: site?.id === "x" ? parseXPostUrl(url) : null,
  };
}

/**
 * Apps put the link in `url`, in `text` (the X app does), or rarely in `title`, sometimes after other links.
 * An X post wins, then any link of a supported site, then the first link at all.
 */
export function extractSharedLink(params: ShareParams): SharedLink | null {
  const links = [...urlsIn(params.url), ...urlsIn(params.text), ...urlsIn(params.title)].map(linkInfo);
  return links.find((link) => link.post) ?? links.find((link) => link.site) ?? links[0] ?? null;
}
