import "server-only";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveTipFromEntries } from "@/lib/twitter-id";
import type { ArchiveTip } from "@/lib/twitter-id";
import { resolveAccountDir } from "@/server/paths";

/**
 * Reads the newest stored post IDs from `<mediaRoot>/<folder>/archive.sqlite3`.
 *
 * Strictly read-only: grabberX never opens an archive for writing. Any missing, locked,
 * empty or unrecognized archive resolves to `undefined` so the update falls back safely.
 */
export async function readArchiveTip(
  mediaRoot: string,
  folder: string,
): Promise<ArchiveTip | undefined> {
  let file: string;
  try {
    file = join(resolveAccountDir(mediaRoot, folder), "archive.sqlite3");
  } catch {
    return undefined;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    // Range bounds hit the WITHOUT ROWID PRIMARY KEY index directly for each supported site prefix.
    const stmt = db.prepare(
      `SELECT entry FROM archive
       WHERE (entry >= 'fapello' AND entry < 'fapellp')
          OR (entry >= 'instagram0' AND entry < 'instagram:')
          OR (entry >= 'pixiv0' AND entry < 'pixiv:')
          OR (entry >= 'twitter0' AND entry < 'twitter:')`,
    );
    const entries = function* (): Generator<string> {
      for (const row of stmt.iterate()) {
        const entry = (row as { entry?: unknown }).entry;
        if (typeof entry === "string") yield entry;
      }
    };
    return archiveTipFromEntries(entries());
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
