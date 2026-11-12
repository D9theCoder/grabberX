import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  etagOf,
  MediaPathError,
  mimeTypeOf,
  parseRange,
  statMediaFile,
} from "@/server/media";
import { cachedThumbnail, getThumbnail, parseThumbSize } from "@/server/thumbs";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, headers?: Record<string, string>): Response {
  return Response.json({ ok: false, error }, { status, headers });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const account = params.get("account") ?? "";
  const path = params.get("path") ?? "";

  let file: Awaited<ReturnType<typeof statMediaFile>>;
  try {
    file = await statMediaFile(account, path);
  } catch (error) {
    if (error instanceof MediaPathError) return fail(error.message, error.status);
    console.error("gather: could not read a media file.", error);
    return fail("That file couldn't be read.", 500);
  }

  const etag = etagOf(file.info);
  // A URL that names the file's version (`v` = the etag the grid already knows) can never change, so the
  // browser keeps it for good and a revisited folder paints from its cache without asking again.
  const versioned = params.get("v") === etag.replaceAll('"', "");
  const common = {
    etag,
    "cache-control": versioned ? "private, max-age=31536000, immutable" : "private, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
    "last-modified": file.info.mtime.toUTCString(),
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: common });
  }

  const thumbParam = params.get("thumb");
  if (thumbParam !== null) {
    const size = parseThumbSize(thumbParam);
    if (size === null) return fail("That thumbnail size isn't available.", 400);
    const isVideo = mimeTypeOf(file.name)?.startsWith("video/") ?? false;
    // A video's poster exists only once a browser has captured one; until then the tile plays its metadata.
    const bytes = isVideo ? await cachedThumbnail(file.full, 480, file.info) : await getThumbnail(file.full, size, file.info);
    if (bytes === null) {
      return isVideo ? fail("No poster yet.", 404) : fail("Thumbnails are unavailable.", 501);
    }
    return new Response(new Uint8Array(bytes), {
      headers: { ...common, "content-type": "image/webp", "content-length": String(bytes.length) },
    });
  }

  const contentType = mimeTypeOf(file.name) ?? "application/octet-stream";
  const range = parseRange(request.headers.get("range"), file.info.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...common, "content-range": `bytes */${file.info.size}` },
    });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? file.info.size - 1;
  const body =
    file.info.size === 0
      ? null
      : (Readable.toWeb(createReadStream(file.full, { start, end })) as ReadableStream);
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...common,
      "content-type": contentType,
      "accept-ranges": "bytes",
      ...(params.get("download") === "1"
        ? { "content-disposition": `attachment; filename="${file.name.replace(/[^\w.()-]/g, "_")}"` }
        : {}),
      "content-length": String(file.info.size === 0 ? 0 : end - start + 1),
      ...(range ? { "content-range": `bytes ${start}-${end}/${file.info.size}` } : {}),
    },
  });
}
