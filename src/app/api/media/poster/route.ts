import { dirname } from "node:path";
import { isAllowedOrigin } from "@/server/hosts";
import { MediaPathError, mimeTypeOf, statMediaFile } from "@/server/media";
import { recordDuration } from "@/server/media-index";
import { savePoster } from "@/server/thumbs";

export const dynamic = "force-dynamic";

function fail(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

/**
 * The grid sends a video's first frame (WebP or JPEG from a canvas) and its length once it has loaded the
 * metadata, so the next visit shows a cached poster instead of opening the video again.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request.headers.get("origin"))) return fail("That request didn't come from this app.", 403);
  const params = new URL(request.url).searchParams;
  let file: Awaited<ReturnType<typeof statMediaFile>>;
  try {
    file = await statMediaFile(params.get("account") ?? "", params.get("path") ?? "");
  } catch (error) {
    if (error instanceof MediaPathError) return fail(error.message, error.status);
    return fail("That file couldn't be read.", 500);
  }
  if (!mimeTypeOf(file.name)?.startsWith("video/")) return fail("Only videos take a poster.", 400);

  const duration = Number(params.get("duration"));
  if (Number.isFinite(duration) && duration > 0) {
    await recordDuration(dirname(file.full), { name: file.name, size: file.info.size, mtimeMs: file.info.mtimeMs, kind: "video" }, duration);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return Response.json({ ok: true });
  const saved = await savePoster(file.full, file.info, bytes);
  return saved !== null ? Response.json({ ok: true }) : fail("That poster isn't a usable image.", 400);
}
