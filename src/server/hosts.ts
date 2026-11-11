// No `server-only` import here: proxy.ts runs outside the React Server Components graph and
// `server-only` throws there. These checks are pure string comparisons with no secrets.
import { appPort } from "@/server/env";

export function allowedHosts(): string[] {
  const port = appPort();
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(): string[] {
  return allowedHosts().map((host) => `http://${host}`);
}

export function isAllowedHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return allowedHosts().includes(host.trim().toLowerCase());
}

/** A missing Origin is allowed (same-origin navigation and curl); a present one must match. */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (origin === null || origin === undefined) return true;
  return allowedOrigins().includes(origin.trim().toLowerCase());
}
