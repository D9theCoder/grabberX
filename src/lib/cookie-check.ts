import type { CookieBrowser, SiteId } from "@/lib/spec";
import { siteDef } from "@/lib/sites";

/**
 * What a cookie probe found. "skipped" means no browser is selected, so there is nothing to test.
 */
export type CookieCheckKind = "ok" | "skipped" | "unreadable" | "signedOut" | "unknown";

/** The parts of a gallery-dl run the classifier needs. */
export interface CookieCheckOutput {
  code: number | null;
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * gallery-dl could not open the browser's cookie database: a locked file, a missing profile,
 * a corrupted database, or a cookie it cannot decrypt. The site then sees an anonymous visitor,
 * so most of these runs also print the sign-in error; this list is checked first.
 */
const UNREADABLE = [
  /unable to find .*cookies database/i,
  /failed to decrypt cookie/i,
  /permission denied/i,
  /\[errno 13\]/i,
  /file is not a database/i,
  /database is locked/i,
  /no such file/i,
  /could not (?:read|open|copy|find) .*cookies?/i,
];

/** The database was read, but the site does not accept the session it holds. */
const SIGNED_OUT = [
  /authrequired/i,
  /authenticated cookies needed/i,
  /cookies needed/i,
  /(?<![/\w])40[13]\b(?!\.\w)/i,
  /unauthori[sz]ed|unauthenticated/i,
  /\blog ?in(?: required| needed)?\b/i,
  /\bsign in\b/i,
];

export function classifyCookieCheck(result: CookieCheckOutput): CookieCheckKind {
  // A missing exe or a network stall says nothing about the cookies; the run itself will report it.
  if (result.spawnError || result.timedOut) return "unknown";
  const output = result.output;
  if (UNREADABLE.some((pattern) => pattern.test(output))) return "unreadable";
  if (SIGNED_OUT.some((pattern) => pattern.test(output))) return "signedOut";
  return result.code === 0 ? "ok" : "unknown";
}

export function browserLabel(browser: CookieBrowser): string {
  return browser === "none" ? "no browser" : browser[0].toUpperCase() + browser.slice(1);
}

/** The site as the copy names it: "x.com", or the site's own label. */
export function cookieSiteLabel(site: SiteId): string {
  return site === "x" ? "x.com" : siteDef(site).label;
}

/**
 * The sentence shown for a failed check. Ok, skipped and unknown show nothing: the run is never
 * blocked, and an unexplained probe failure is not worth a warning.
 */
export function cookieNotice(
  kind: CookieCheckKind,
  labels: { browser: string; site: string },
): string | null {
  switch (kind) {
    case "unreadable":
      return `grabberX can't read ${labels.browser}'s cookies. Close ${labels.browser}, or pick another browser in Settings.`;
    case "signedOut":
      return `${labels.browser} cookies for ${labels.site} look signed out. Sign in to ${labels.site} in ${labels.browser}, then try again.`;
    default:
      return null;
  }
}
