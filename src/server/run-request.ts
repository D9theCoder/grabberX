import "server-only";
import { z } from "zod";
import { folderNameFor, validateAccount } from "@/lib/sites";
import type { JobSpec } from "@/lib/spec";
import { parseJobSpec } from "@/lib/spec-schema";
import { isReserved, isValidFolderName } from "@/server/paths";

export const accountHintInput = z.object({
  site: z.enum(["x", "instagram", "bluesky", "pixiv", "reddit", "url"]),
  account: z.string().max(2048),
  folder: z.string().max(64).optional(),
});

export function folderProblem(folder: string): string | null {
  if (!isValidFolderName(folder)) {
    return "Folder names can use letters, numbers, dots, dashes and underscores, up to 64 characters.";
  }
  if (isReserved(folder)) {
    return `"${folder}" is used by the app itself. Choose a different folder name in Advanced → Folder name.`;
  }
  return null;
}

// The desktop Run screen and a paired phone start runs through this one check, so a phone can never
// queue anything the desktop form would refuse.
export function prepareRunSpec(input: unknown): { ok: true; spec: JobSpec } | { ok: false; error: string } {
  const parsed = parseJobSpec(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const validated = validateAccount(parsed.data.site, parsed.data.account);
  if (!validated.ok) return { ok: false, error: validated.message };
  const spec: JobSpec = { ...parsed.data, account: validated.account };

  let folder: string;
  try {
    folder = folderNameFor(spec);
  } catch {
    return {
      ok: false,
      error: "That account can't be used as a folder name. Pick one in Advanced → Folder name.",
    };
  }
  const problem = folderProblem(folder);
  if (problem) return { ok: false, error: problem };
  return { ok: true, spec };
}
