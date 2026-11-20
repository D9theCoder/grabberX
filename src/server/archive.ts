import "server-only";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { twitterArchiveTip } from "@/lib/twitter-id";
import type { ArchiveTip } from "@/lib/twitter-id";
import { resolveAccountDir } from "@/server/paths";

/**
 * Reads the newest stored X post IDs from `<mediaRoot>/<folder>/archive.sqlite3`.
 *
 * Strictly read-only: grabberX never opens an archive for writing. Any missing, locked,
 * empty or non-Twitter archive resolves to `undefined` so the update falls back safely.
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
    // Range bounds hit the WITHOUT ROWID PRIMARY KEY index directly and ignore non-Twitter rows.
    const stmt = db.prepare(
      "SELECT entry FROM archive WHERE entry >= 'twitter0' AND entry < 'twitter:'",
    );
    const entries = function* (): Generator<string> {
      for (const row of stmt.iterate()) {
        const entry = (row as { entry?: unknown }).entry;
        if (typeof entry === "string") yield entry;
      }
    };
    return twitterArchiveTip(entries());
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
