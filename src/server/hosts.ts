// No `server-only` import here: proxy.ts runs outside the React Server Components graph and
// `server-only` throws there. These checks are pure string comparisons with no secrets.

export const ALLOWED_HOSTS: readonly string[] = ["127.0.0.1:3210", "localhost:3210"];

export const ALLOWED_ORIGINS: readonly string[] = [
  "http://127.0.0.1:3210",
  "http://localhost:3210",
];

export function isAllowedHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return ALLOWED_HOSTS.includes(host.trim().toLowerCase());
}

/** A missing Origin is allowed (same-origin navigation and curl); a present one must match. */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (origin === null || origin === undefined) return true;
  return ALLOWED_ORIGINS.includes(origin.trim().toLowerCase());
}
