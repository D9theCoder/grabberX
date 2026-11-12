import type { JobSpec, Media, SiteId } from "@/lib/spec";

export interface SiteDef {
  id: SiteId;
  label: string;
  /** Fixed text shown before the account input, e.g. "@". */
  prefix: string;
  placeholder: string;
  beta: boolean;
  /**
   * The site does not rate-limit its listing, so several gallery-dl processes may walk one profile at once
   * (each lists the whole profile and downloads its own slice). Off for sites whose API limits requests.
   */
  parallel: boolean;
  supportsSize: boolean;
  /** Hostnames accepted in a pasted profile URL (without www/mobile). */
  hosts: string[];
  /** The bare account must match this. Unused for site "url". */
  handlePattern: RegExp;
  /** Shown when the account does not match handlePattern. */
  handleError: string;
  /** Shown when a pasted link points somewhere else. */
  linkError: string;
  urlFor(account: string): string;
  /** The account (or last path segment) inside a pasted profile URL. */
  handleFromPath(segments: string[]): string | null;
  /** argv for one download step of a run: media selection flags only. */
  mediaOptions(media: Media): string[];
}

const IMAGE_FILTER = "extension in ('jpg','jpeg','png','webp')";
const VIDEO_FILTER = "extension in ('mp4','webm','mov','m4v')";

/** First path segment of a pasted link that is never a profile. */
const NON_PROFILE_PATHS = new Set([
  "i",
  "home",
  "search",
  "hashtag",
  "notifications",
  "explore",
  "settings",
  "status",
  "intent",
  "share",
  "login",
  "signup",
  "p",
  "reel",
  "reels",
  "stories",
  "accounts",
]);

function genericMediaOptions(media: Media): string[] {
  return ["--filter", media === "videos" ? VIDEO_FILTER : IMAGE_FILTER];
}

function twitterMediaOptions(media: Media): string[] {
  if (media === "videos") {
    return [
      "-o",
      "twitter.videos=true",
      "-o",
      "twitter.gifs=true",
      "--filter",
      VIDEO_FILTER,
    ];
  }
  return [
    "-o",
    "twitter.videos=false",
    "-o",
    "twitter.gifs=false",
    "--filter",
    IMAGE_FILTER,
  ];
}

export const SITES: SiteDef[] = [
  {
    id: "x",
    label: "X",
    prefix: "@",
    placeholder: "username",
    beta: false,
    parallel: false,
    supportsSize: true,
    hosts: ["x.com", "twitter.com"],
    handlePattern: /^[A-Za-z0-9_]{1,15}$/,
    handleError: "X handles are 1–15 letters, numbers or _",
    linkError: "That link isn't an X profile.",
    urlFor: (account) => `https://x.com/${account}/media`,
    handleFromPath: (segments) =>
      segments[0] && !NON_PROFILE_PATHS.has(segments[0])
        ? segments[0]
        : null,
    mediaOptions: twitterMediaOptions,
  },
  {
    id: "instagram",
    label: "Instagram",
    prefix: "@",
    placeholder: "username",
    beta: true,
    parallel: false,
    supportsSize: false,
    hosts: ["instagram.com"],
    handlePattern: /^[A-Za-z0-9._]{1,30}$/,
    handleError: "Instagram usernames are 1–30 letters, numbers, periods or _",
    linkError: "That link isn't an Instagram profile.",
    urlFor: (account) => `https://www.instagram.com/${account}/`,
    handleFromPath: (segments) =>
      segments[0] && !NON_PROFILE_PATHS.has(segments[0])
        ? segments[0]
        : null,
    mediaOptions: genericMediaOptions,
  },
  {
    id: "bluesky",
    label: "Bluesky",
    prefix: "bsky.app/profile/",
    placeholder: "name.bsky.social",
    beta: true,
    parallel: true,
    supportsSize: false,
    hosts: ["bsky.app"],
    handlePattern: /^[A-Za-z0-9._:-]{1,100}$/,
    handleError: "Bluesky handles look like name.bsky.social",
    linkError: "That link isn't a Bluesky profile.",
    urlFor: (account) => `https://bsky.app/profile/${account}`,
    handleFromPath: (segments) =>
      segments[0] === "profile" ? (segments[1] ?? null) : null,
    mediaOptions: genericMediaOptions,
  },
  {
    id: "pixiv",
    label: "Pixiv",
    prefix: "pixiv.net/users/",
    placeholder: "12345",
    beta: true,
    parallel: false,
    supportsSize: false,
    hosts: ["pixiv.net"],
    handlePattern: /^\d{1,12}$/,
    handleError: "Pixiv accounts are numeric user ids",
    linkError: "That link isn't a Pixiv profile.",
    urlFor: (account) => `https://www.pixiv.net/en/users/${account}`,
    handleFromPath: (segments) => {
      const index = segments.indexOf("users");
      return index >= 0 ? (segments[index + 1] ?? null) : null;
    },
    mediaOptions: genericMediaOptions,
  },
  {
    id: "reddit",
    label: "Reddit",
    prefix: "u/",
    placeholder: "username",
    beta: true,
    parallel: false,
    supportsSize: false,
    hosts: ["reddit.com"],
    handlePattern: /^[A-Za-z0-9_-]{1,20}$/,
    handleError: "Reddit usernames are 1–20 letters, numbers, - or _",
    linkError: "That link isn't a Reddit profile.",
    urlFor: (account) => `https://www.reddit.com/user/${account}/submitted/`,
    handleFromPath: (segments) => {
      if (segments[0] === "u" || segments[0] === "user") {
        return segments[1] ?? null;
      }
      return segments[0] === "r" ? null : (segments[0] ?? null);
    },
    mediaOptions: genericMediaOptions,
  },
  {
    id: "url",
    label: "Other URL",
    prefix: "",
    placeholder: "https://",
    beta: true,
    parallel: true,
    supportsSize: false,
    hosts: [],
    handlePattern: /^https?:\/\/\S+$/i,
    handleError: "Enter the full URL, starting with http:// or https://",
    linkError: "Enter the full URL, starting with http:// or https://",
    urlFor: (account) => account,
    handleFromPath: () => null,
    mediaOptions: genericMediaOptions,
  },
];

export function siteDef(site: SiteId): SiteDef {
  const def = SITES.find((entry) => entry.id === site);
  if (!def) throw new Error(`unknown site: ${site}`);
  return def;
}

export const FOLDER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Accepts a handle or a pasted profile URL. Returns the normalized account, or a user-facing message. */
export function validateAccount(
  site: SiteId,
  input: string,
): { ok: true; account: string } | { ok: false; message: string } {
  const def = siteDef(site);
  const raw = input.trim();

  if (def.id === "url") {
    if (def.handlePattern.test(raw)) return { ok: true, account: raw };
    return {
      ok: false,
      message: raw ? def.handleError : "Paste the page URL.",
    };
  }

  if (!raw) return { ok: false, message: "Enter an account." };

  const link = splitLink(raw);
  if (link) {
    const host = link.host.toLowerCase().replace(/^(www|mobile|m)\./, "");
    if (!def.hosts.includes(host)) return { ok: false, message: def.linkError };
    const candidate = def.handleFromPath(link.segments);
    if (!candidate) return { ok: false, message: def.linkError };
    const handle = candidate.replace(/^@/, "");
    if (!def.handlePattern.test(handle)) {
      return { ok: false, message: def.handleError };
    }
    return { ok: true, account: handle };
  }

  const handle = raw.replace(/^@/, "");
  if (!def.handlePattern.test(handle)) {
    return { ok: false, message: def.handleError };
  }
  return { ok: true, account: handle };
}

/** The named site a page URL points to, so a generic "Other URL" run still follows that site's rules. */
export function siteForUrl(url: string): SiteDef | null {
  const link = splitLink(url.trim());
  if (!link) return null;
  const host = link.host.toLowerCase();
  return SITES.find((def) => def.hosts.some((known) => host === known || host.endsWith(`.${known}`))) ?? null;
}

/** The <acct> folder name for a spec: spec.folder when set, else derived from the account. */
export function folderNameFor(
  spec: Pick<JobSpec, "site" | "account" | "folder">,
): string {
  const explicit = spec.folder?.trim();
  if (explicit) return safeFolder(explicit);
  if (spec.site === "url") return safeFolder(folderFromUrl(spec.account));
  return safeFolder(spec.account.replace(/^@/, ""));
}

function splitLink(
  input: string,
): { host: string; segments: string[] } | null {
  const candidate = /^https?:\/\//i.test(input) ? input : maybeHost(input);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return {
      host: url.hostname,
      segments: url.pathname.split("/").filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** "x.com/foo/media" → "https://x.com/foo/media"; a bare handle stays null. */
function maybeHost(input: string): string | null {
  if (!input.includes("/")) return null;
  const first = input.split("/")[0];
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(first)
    ? `https://${input}`
    : null;
}

function folderFromUrl(account: string): string {
  try {
    const url = new URL(account);
    const host = url.hostname.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    return last ? `${host}_${last}` : host;
  } catch {
    return account;
  }
}

function safeFolder(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  const trimmed = cleaned.replace(/\.+$/, "");
  return trimmed || "account";
}
