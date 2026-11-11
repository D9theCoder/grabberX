import { join } from "node:path";
import { listFolder, MediaPathError, resolveMediaPath } from "@/server/media";
import { getSettings } from "@/server/store";
import { readDimensions } from "@/server/thumbs";

export const dynamic = "force-dynamic";

type Dimensions = Record<string, [number, number]>;

// Keyed by path, size and modified time, so the grid can ask for a whole folder again without re-reading headers.
const cache = new Map<string, [number, number] | null>();
const CACHE_MAX = 50_000;
const CONCURRENCY = 16;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const account = params.get("account") ?? "";
  const path = params.get("path") ?? "";

  try {
    const listing = await listFolder(account, path);
    const settings = await getSettings();
    const { full } = await resolveMediaPath(settings.mediaRoot, account, path);
    const images = listing.files.filter((file) => file.kind === "image");
    const found: Dimensions = {};
    let next = 0;
    async function worker() {
      while (next < images.length) {
        const file = images[next++];
        if (!file) break;
        const key = `${full}|${file.name}|${file.size}|${Math.floor(file.mtimeMs)}`;
        let value = cache.get(key);
        if (value === undefined) {
          value = await readDimensions(join(full, file.name));
          if (cache.size >= CACHE_MAX) cache.clear();
          cache.set(key, value);
        }
        if (value) found[file.name] = value;
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return Response.json({ ok: true, dimensions: found });
  } catch (error) {
    if (error instanceof MediaPathError) {
      return Response.json({ ok: false, error: error.message }, { status: error.status });
    }
    console.error("gather: could not read image sizes.", error);
    return Response.json({ ok: false, error: "Image sizes couldn't be read." }, { status: 500 });
  }
}
