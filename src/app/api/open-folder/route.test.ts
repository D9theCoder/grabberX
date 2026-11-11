import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: h.spawn }));
vi.mock("@/server/store", () => ({ getSettings: h.getSettings }));

let sandbox = "";

beforeEach(async () => {
  vi.clearAllMocks();
  if (sandbox === "") sandbox = await mkdtemp(join(tmpdir(), "gather-open-"));
  await mkdir(join(sandbox, "username"), { recursive: true });
  h.getSettings.mockResolvedValue({ mediaRoot: sandbox });
  h.spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
});

afterAll(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

function request(body: unknown, origin?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== undefined) headers.origin = origin;
  return new Request("http://127.0.0.1:3210/api/open-folder", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/open-folder", () => {
  it("opens an account folder in explorer", async () => {
    const response = await POST(request({ folder: "username" }, "http://127.0.0.1:3210"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const dir = join(sandbox, "username");
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledWith("explorer.exe", [dir], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
  });

  it("allows a request without an Origin header", async () => {
    const response = await POST(request({ folder: "username" }));
    expect(response.status).toBe(200);
  });

  it("rejects a request from another origin", async () => {
    const response = await POST(request({ folder: "username" }, "http://evil.com"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("rejects a folder name that could escape the media root", async () => {
    for (const folder of ["..", "../escape", "a/b", "C:\\Windows"]) {
      const response = await POST(request({ folder }));
      expect(response.status, folder).toBe(400);
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("refuses to open the app's own folders", async () => {
    for (const folder of ["src", "SRC", "docs", "node_modules", ".git"]) {
      await mkdir(join(sandbox, folder), { recursive: true });
      const response = await POST(request({ folder }));
      expect(response.status, folder).toBe(400);
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a folder", async () => {
    const response = await POST(request("{ nope"));
    expect(response.status).toBe(400);
  });

  it("reports a folder that is not on disk", async () => {
    const response = await POST(request({ folder: "not_here" }));
    expect(response.status).toBe(404);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
