const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Windows refuses to rename over a file that another handle has open, even for a moment (a concurrent read,
 * antivirus, the search indexer). The same call succeeds a few milliseconds later, so retry briefly before
 * reporting a failure.
 */
export async function retryTransient<T>(
  action: () => Promise<T>,
  { attempts = 6, delayMs = 25 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_CODES.has(code) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}
