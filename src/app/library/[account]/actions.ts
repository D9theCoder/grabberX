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

export type PathsResult = { ok: true; paths: Record<string, string>; recycle: boolean } | { ok: false; error: string };

const BULK_MAX = 5000;

function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** Absolute paths for a selection, for the shell (Recycle Bin, Show in folder). Unknown names are left out. */
export async function getFilePaths(account: string, folder: string, names: string[]): Promise<PathsResult> {
  if (names.length > BULK_MAX) return { ok: false, error: "That is too many files at once." };
  const paths: Record<string, string> = {};
  for (const name of names) {
    try {
      paths[name] = (await statMediaFile(account, joinPath(folder, name))).full;
    } catch {
      /* gone or invalid: nothing to act on */
    }
  }
  return { ok: true, paths, recycle: isPackaged() };
}

export type BulkDeleteResult = { ok: true; deleted: string[]; failed: string[] } | { ok: false; error: string };

/**
 * Deletes a selection. As with one file, the archive is left alone so nothing downloads again. `trashed` lists
 * the files the desktop shell already moved to the Recycle Bin; those are only checked.
 */
export async function deleteFiles(
  account: string,
  folder: string,
  names: string[],
  trashed: string[],
): Promise<BulkDeleteResult> {
  if (names.length > BULK_MAX) return { ok: false, error: "That is too many files at once." };
  const wasTrashed = new Set(trashed);
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    const result = await deleteFile(account, joinPath(folder, name), wasTrashed.has(name));
    if (result.ok) deleted.push(name);
    else failed.push(name);
  }
  return { ok: true, deleted, failed };
}
