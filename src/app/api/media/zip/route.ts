import { isAllowedOrigin } from "@/server/hosts";
import { MediaPathError, statMediaFile } from "@/server/media";
import { ZIP_MAX_BYTES, ZIP_MAX_FILES, zipStream } from "@/server/zip";
import type { ZipEntry } from "@/server/zip";

export const dynamic = "force-dynamic";

function fail(error: string, status: number): Response {
  return new Response(error, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/**
 * Several gallery files as one zip. The page posts a plain form (account, folder path, one `name` per file),
 * so the browser treats the answer as a download and streams it straight to disk.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request.headers.get("origin"))) return fail("That request didn't come from this app.", 403);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("That request didn't list any files.", 400);
  }
  const account = String(form.get("account") ?? "");
  const folder = String(form.get("path") ?? "");
  const names = [...new Set(form.getAll("name").map(String))];
  if (names.length === 0) return fail("Choose at least one file.", 400);
  if (names.length > ZIP_MAX_FILES) return fail("Too many files for one zip. Choose fewer.", 400);

  const entries: ZipEntry[] = [];
  let total = 0;
  try {
    for (const name of names) {
      const file = await statMediaFile(account, folder === "" ? name : `${folder}/${name}`);
      total += file.info.size;
      entries.push({ name: file.name, path: file.full, size: file.info.size, mtime: file.info.mtime });
    }
  } catch (error) {
    if (error instanceof MediaPathError) return fail(error.message, error.status);
    return fail("Those files couldn't be read.", 500);
  }
  if (total > ZIP_MAX_BYTES) return fail("Those files are over 4 GB together. Choose fewer.", 413);

  const label = `${account}${folder ? `-${folder.replaceAll("/", "-")}` : ""}-${entries.length}-files`.replace(/[^\w.-]/g, "_");
  return new Response(zipStream(entries), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${label}.zip"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
