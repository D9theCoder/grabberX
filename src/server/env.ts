// No `server-only` import and no node: imports: src/proxy.ts reaches this through hosts.ts and runs
// outside the React Server Components graph.

export const DEFAULT_PORT = 3210;

/**
 * The Electron shell sets GATHER_PACKAGED=1. Only then do missing paths fail loudly, because the
 * `process.cwd()` fallbacks that suit `npm run dev` would point into the install directory, which
 * every update replaces.
 */
export function isPackaged(): boolean {
  return process.env.GATHER_PACKAGED === "1";
}

export function appPort(): number {
  const raw = process.env.GATHER_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`GATHER_PORT must be a port number between 1 and 65535, got "${raw}".`);
  }
  return port;
}

function fromEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requiredWhenPackaged(name: string): string | undefined {
  const value = fromEnv(name);
  if (value === undefined && isPackaged()) {
    throw new Error(`${name} must be set when gather runs as the packaged app.`);
  }
  return value;
}

/** Where run records, settings and logs live. Undefined means "use the dev fallback". */
export function envHome(): string | undefined {
  return requiredWhenPackaged("GATHER_HOME");
}

/** Where account folders live until the user picks one in Settings. */
export function envMediaRoot(): string | undefined {
  return requiredWhenPackaged("GATHER_MEDIA_ROOT");
}

export function envGalleryDl(): string | undefined {
  return requiredWhenPackaged("GATHER_GALLERY_DL");
}

/** The install directory; a library placed inside it would be lost on update. */
export function envAppDir(): string | undefined {
  return fromEnv("GATHER_APP_DIR");
}

/** Set by the shell from the installed app's version; "dev" when running from source. */
export function appVersion(): string {
  return fromEnv("GATHER_APP_VERSION") ?? "dev";
}
