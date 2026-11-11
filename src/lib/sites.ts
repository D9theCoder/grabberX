import type { JobSpec, SiteId } from "@/lib/spec";

export interface SiteDef {
  id: SiteId;
  label: string;
  /** Fixed text shown before the account input, e.g. "@". */
  prefix: string;
  placeholder: string;
  beta: boolean;
  supportsSize: boolean;
}

export const SITES: SiteDef[] = [
  { id: "x", label: "X", prefix: "@", placeholder: "username", beta: false, supportsSize: true },
  { id: "instagram", label: "Instagram", prefix: "@", placeholder: "username", beta: true, supportsSize: false },
  { id: "bluesky", label: "Bluesky", prefix: "bsky.app/profile/", placeholder: "name.bsky.social", beta: true, supportsSize: false },
  { id: "pixiv", label: "Pixiv", prefix: "pixiv.net/users/", placeholder: "12345", beta: true, supportsSize: false },
  { id: "reddit", label: "Reddit", prefix: "u/", placeholder: "username", beta: true, supportsSize: false },
  { id: "url", label: "Other URL", prefix: "", placeholder: "https://", beta: true, supportsSize: false },
];

/** Accepts a handle or a pasted profile URL. Returns the normalized account, or a user-facing message. */
export function validateAccount(
  _site: SiteId,
  _input: string,
): { ok: true; account: string } | { ok: false; message: string } {
  throw new Error("not implemented");
}

/** The <acct> folder name for a spec: spec.folder when set, else derived from the account. */
export function folderNameFor(_spec: Pick<JobSpec, "site" | "account" | "folder">): string {
  throw new Error("not implemented");
}
