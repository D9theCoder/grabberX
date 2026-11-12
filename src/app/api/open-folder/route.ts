import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAllowedOrigin } from "@/server/hosts";
import { isReserved, isValidFolderName, resolveAccountDir } from "@/server/paths";
import { getSettings } from "@/server/store";

function fail(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request.headers.get("origin"))) {
    return fail("That request didn't come from this app.", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("That request didn't include a folder.", 400);
  }
  const raw =
    typeof body === "object" && body !== null ? (body as { folder?: unknown }).folder : undefined;
  // Reserved names (src, docs, .git, ...) are the app's own folders, never accounts.
  if (typeof raw !== "string" || !isValidFolderName(raw) || isReserved(raw)) {
    return fail("That folder name isn't valid.", 400);
  }

  const settings = await getSettings();
  let dir: string;
  try {
    dir = resolveAccountDir(settings.mediaRoot, raw);
  } catch {
    return fail("That folder name isn't valid.", 400);
  }

  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    return fail("That folder doesn't exist.", 404);
  }

  const explorer = spawn("explorer.exe", [dir], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  // explorer.exe exits non-zero even when it opens the window; only spawn errors matter.
  explorer.on("error", (error: unknown) => {
    console.error("grabberX: could not open the folder.", error);
  });
  explorer.unref();

  return Response.json({ ok: true });
}
