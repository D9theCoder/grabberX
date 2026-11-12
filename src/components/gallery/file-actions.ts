"use client";

import { deleteFiles, getFilePaths } from "@/app/library/[account]/actions";
import { mediaUrl } from "@/components/gallery/thumbnail";

/** One file downloads as itself; several stream from the server as one zip, straight to disk. */
export function downloadFiles(account: string, folder: string, names: readonly string[]) {
  if (names.length === 0) return;
  if (names.length === 1) {
    const link = document.createElement("a");
    link.href = `${mediaUrl(account, folder, names[0]!)}&download=1`;
    link.download = names[0]!;
    document.body.append(link);
    link.click();
    link.remove();
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/media/zip";
  form.hidden = true;
  const add = (name: string, value: string) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  };
  add("account", account);
  add("path", folder);
  for (const name of names) add("name", name);
  document.body.append(form);
  form.submit();
  form.remove();
}

/** The clipboard takes PNG only, so other formats are redrawn first. */
export async function copyImage(account: string, folder: string, name: string): Promise<void> {
  const blob = await (await fetch(mediaUrl(account, folder, name))).blob();
  let png = blob;
  if (blob.type !== "image/png") {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("no image"))), "image/png"),
    );
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export async function copyPaths(account: string, folder: string, names: readonly string[]): Promise<number> {
  const result = await getFilePaths(account, folder, [...names]);
  if (!result.ok) throw new Error(result.error);
  const paths = names.map((name) => result.paths[name]).filter((path): path is string => Boolean(path));
  await navigator.clipboard.writeText(paths.join("\r\n"));
  return paths.length;
}

/** Desktop: Explorer with the file selected. Browser: the account folder, the closest the server can do. */
export async function showInFolder(account: string, folder: string, name: string): Promise<boolean> {
  const shell = window.gatherShell;
  if (shell?.showItem) {
    const result = await getFilePaths(account, folder, [name]);
    const path = result.ok ? result.paths[name] : undefined;
    return path ? shell.showItem(path) : false;
  }
  const response = await fetch("/api/open-folder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder: account }),
  });
  return response.ok;
}

export async function openWithApp(account: string, folder: string, name: string): Promise<boolean> {
  const shell = window.gatherShell;
  if (!shell?.openItem) {
    window.open(mediaUrl(account, folder, name), "_blank", "noopener");
    return true;
  }
  const result = await getFilePaths(account, folder, [name]);
  const path = result.ok ? result.paths[name] : undefined;
  return path ? shell.openItem(path) : false;
}

export interface DeleteOutcome {
  deleted: string[];
  error?: string;
}

/**
 * Deletes a selection the way the lightbox deletes one file: the desktop app moves each file to the Recycle
 * Bin through the shell first, then the server checks they are gone. The archive is never touched.
 */
export async function deleteSelection(account: string, folder: string, names: readonly string[]): Promise<DeleteOutcome> {
  const located = await getFilePaths(account, folder, [...names]);
  if (!located.ok) return { deleted: [], error: located.error };
  const trashed: string[] = [];
  if (located.recycle) {
    const shell = window.gatherShell;
    if (!shell?.trashItem) return { deleted: [], error: "Moving files to the Recycle Bin needs the desktop app." };
    for (const name of names) {
      const path = located.paths[name];
      if (path && (await shell.trashItem(path))) trashed.push(name);
    }
  }
  const targets = located.recycle ? trashed : [...names];
  if (targets.length === 0) return { deleted: [], error: "No files could be moved to the Recycle Bin." };
  const result = await deleteFiles(account, folder, targets, trashed);
  if (!result.ok) return { deleted: [], error: result.error };
  const missed = names.length - result.deleted.length;
  return {
    deleted: result.deleted,
    error: missed > 0 ? `${missed} ${missed === 1 ? "file" : "files"} couldn't be deleted. Close anything using them and try again.` : undefined,
  };
}
