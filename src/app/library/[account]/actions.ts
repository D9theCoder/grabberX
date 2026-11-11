"use server";

import { stat } from "node:fs/promises";
import { isPackaged } from "@/server/env";
import { invalidateAccountStats } from "@/server/library";
import { deleteMediaFile, MediaPathError, statMediaFile } from "@/server/media";

export type FileDetails =
  | { ok: true; absolutePath: string; size: number; mtimeMs: number; recycle: boolean }
  | { ok: false; error: string };

export type DeleteResult = { ok: true } | { ok: false; error: string };

function messageOf(error: unknown): string {
  return error instanceof MediaPathError ? error.message : "That file couldn't be read.";
}

/** The absolute path is for "Copy path" and for the shell, which moves the file to the Recycle Bin. */
export async function getFileDetails(account: string, path: string): Promise<FileDetails> {
  try {
    const file = await statMediaFile(account, path);
    return {
      ok: true,
      absolutePath: file.full,
      size: file.info.size,
      mtimeMs: file.info.mtimeMs,
      recycle: isPackaged(),
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * Deletes one media file. The archive is not touched, so a later run still skips the file.
 * In the packaged app the shell has already moved the file to the Recycle Bin (`trashed`) and this only
 * checks that it is gone; from source it is deleted for good.
 */
export async function deleteFile(account: string, path: string, trashed: boolean): Promise<DeleteResult> {
  try {
    if (trashed) {
      const still = await stat((await statMediaFile(account, path)).full).catch(() => null);
      if (still) return { ok: false, error: "The file is still there. Try again." };
    } else if (isPackaged()) {
      return { ok: false, error: "Moving a file to the Recycle Bin needs the desktop app." };
    } else {
      await deleteMediaFile(account, path);
    }
    invalidateAccountStats(account);
    return { ok: true };
  } catch (error) {
    if (trashed && error instanceof MediaPathError && error.status === 404) {
      invalidateAccountStats(account);
      return { ok: true };
    }
    console.error("gather: could not delete a media file.", error);
    return { ok: false, error: "That file couldn't be deleted. Close anything using it and try again." };
  }
}
