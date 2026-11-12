import { listFolder, MediaPathError, resolveMediaPath } from "@/server/media";
import { completeMeta } from "@/server/media-index";
import { getSettings } from "@/server/store";

export const dynamic = "force-dynamic";

/** Image sizes and video lengths for one folder. Reads only the headers the on-disk index doesn't have yet. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const account = params.get("account") ?? "";
  const path = params.get("path") ?? "";

  try {
    const listing = await listFolder(account, path);
    const settings = await getSettings();
    const { full } = await resolveMediaPath(settings.mediaRoot, account, path);
    const meta = await completeMeta(full, listing.files);
    return Response.json({ ok: true, dimensions: meta.dimensions, durations: meta.durations });
  } catch (error) {
    if (error instanceof MediaPathError) {
      return Response.json({ ok: false, error: error.message }, { status: error.status });
    }
    console.error("gather: could not read image sizes.", error);
    return Response.json({ ok: false, error: "Image sizes couldn't be read." }, { status: 500 });
  }
}
