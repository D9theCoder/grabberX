import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startGateway } from "@/server/mobile/gateway";
import type { GatewayHandle } from "@/server/mobile/gateway";
import { createPairingToken, resetPairingState } from "@/server/mobile/pairing";
import { listDevices, revokeAllDevices, setDeviceCanDownload } from "@/server/mobile/devices";
import { DEFAULT_ADVANCED } from "@/lib/spec";

const runnerMock = vi.hoisted(() => ({
  mode: "lines" as "lines" | "tree",
  calls: [] as string[][],
}));

const fixture = fileURLToPath(new URL("../__fixtures__/fake-gallery-dl.mjs", import.meta.url));

vi.mock("@/server/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/runner")>();
  return {
    ...actual,
    startProcess: (options: Parameters<typeof actual.startProcess>[0]) => {
      if (options.exe === "fake-gallery-dl.exe") {
        runnerMock.calls.push(options.argv);
        return actual.startProcess({
          ...options,
          exe: process.execPath,
          argv: [fixture, `--mode=${runnerMock.mode}`],
        });
      }
      return actual.startProcess(options);
    },
  };
});

let sandbox = "";
let mediaRoot = "";
let upstream: Server;
let gateway: GatewayHandle;
let upstreamHits = 0;

let hooksModule: typeof import("@/server/mobile/hooks");
let queueModule: typeof import("@/server/run-queue");
let storeModule: typeof import("@/server/store");

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-hooks-"));
  const bootHome = await mkdtemp(join(sandbox, "boot-home-"));
  mediaRoot = await mkdtemp(join(sandbox, "media-"));
  process.env.GATHER_HOME = bootHome;
  process.env.GATHER_MEDIA_ROOT = mediaRoot;
  process.env.GATHER_GALLERY_DL = "fake-gallery-dl.exe";
  // RunQueue executes markInterrupted on import, so GATHER_HOME must point into the sandbox first.
  [hooksModule, queueModule, storeModule] = await Promise.all([
    import("@/server/mobile/hooks"),
    import("@/server/run-queue"),
    import("@/server/store"),
  ]);
  await queueModule.runQueue.whenReady();
});

beforeEach(async () => {
  runnerMock.mode = "lines";
  runnerMock.calls = [];
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "home-"));
  process.env.GATHER_MEDIA_ROOT = mediaRoot;
  process.env.GATHER_GALLERY_DL = "fake-gallery-dl.exe";
  upstreamHits = 0;
  upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>gallery</p>");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  gateway = await startGateway({
    port: 0,
    host: "127.0.0.1",
    upstreamPort: (upstream.address() as AddressInfo).port,
    ...hooksModule.createMobileHooks(),
  });
});

afterEach(async () => {
  await queueModule.runQueue.stopAll();
  resetPairingState();
  await revokeAllDevices();
  await gateway.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  delete process.env.GATHER_MEDIA_ROOT;
  delete process.env.GATHER_GALLERY_DL;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

const url = (path: string) => `http://127.0.0.1:${gateway.port}${path}`;
const JSON_HEADERS = {
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/130.0.0.0 Mobile",
};
const pair = (token: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(url("/m/api/pair"), { method: "POST", headers, body: JSON.stringify({ token }) });

async function pairPhone(canDownload = false): Promise<string> {
  const { token } = createPairingToken();
  const res = await pair(token);
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  if (canDownload) {
    const device = listDevices()[0]!;
    expect(await setDeviceCanDownload(device.id, true)).toBe(true);
  }
  return cookie;
}

describe("isSameSiteJsonPost", () => {
  it("requires a JSON content type", () => {
    expect(hooksModule.isSameSiteJsonPost({ "content-type": "text/plain" })).toBe(false);
    expect(hooksModule.isSameSiteJsonPost({ "content-type": "application/x-www-form-urlencoded" })).toBe(false);
    expect(hooksModule.isSameSiteJsonPost({})).toBe(false);
    expect(hooksModule.isSameSiteJsonPost({ "content-type": "application/json" })).toBe(true);
  });
  it("requires an Origin that matches the Host when one is sent", () => {
    expect(
      hooksModule.isSameSiteJsonPost({
        "content-type": "application/json",
        origin: "http://192.168.1.5:3211",
        host: "192.168.1.5:3211",
      }),
    ).toBe(true);
    expect(
      hooksModule.isSameSiteJsonPost({
        "content-type": "application/json",
        origin: "http://evil.example",
        host: "192.168.1.5:3211",
      }),
    ).toBe(false);
    expect(
      hooksModule.isSameSiteJsonPost({
        "content-type": "application/json",
        origin: "null",
        host: "192.168.1.5:3211",
      }),
    ).toBe(false);
  });
});

describe("pairing over HTTP", () => {
  it("trades a fresh code for an HttpOnly, SameSite=Lax session that opens the gallery", async () => {
    const { token } = createPairingToken();
    const res = await pair(token);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^gather_m=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/);
    expect(cookie).not.toContain("Secure");
    expect(listDevices()).toHaveLength(1);

    const page = await fetch(url("/m"), { headers: { cookie: cookie.split(";")[0] } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<p>gallery</p>");
  });

  it("spends the code: the second try fails", async () => {
    const { token } = createPairingToken();
    expect((await pair(token)).status).toBe(200);
    const again = await pair(token);
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(listDevices()).toHaveLength(1);
  });

  it("gives a wrong code the same answer as a used one", async () => {
    const res = await pair("a".repeat(26));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/didn't work/);
  });

  it("refuses a form post and a cross-origin post", async () => {
    const { token } = createPairingToken();
    const form = await fetch(url("/m/api/pair"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${token}`,
    });
    expect(form.status).toBe(400);
    const cross = await pair(token, { ...JSON_HEADERS, origin: "http://evil.example" });
    expect(cross.status).toBe(400);
    expect(listDevices()).toHaveLength(0);
    // The code survives both refusals.
    expect((await pair(token)).status).toBe(200);
  });

  it("refuses bad JSON and an oversized body", async () => {
    const bad = await fetch(url("/m/api/pair"), { method: "POST", headers: JSON_HEADERS, body: "{nope" });
    expect(bad.status).toBe(400);
    const big = await fetch(url("/m/api/pair"), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "a".repeat(5000) }),
    }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
  });

  it("rate limits repeated wrong codes", async () => {
    for (let i = 0; i < 5; i += 1) expect((await pair("a".repeat(26))).status).toBe(401);
    const { token } = createPairingToken();
    const blocked = await pair(token);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("logs a phone out and clears the cookie", async () => {
    const { token } = createPairingToken();
    const paired = await pair(token);
    const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];
    const out = await fetch(url("/m/api/logout"), { method: "POST", headers: { ...JSON_HEADERS, cookie }, body: "{}" });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(listDevices()).toHaveLength(0);
    const page = await fetch(url("/m"), { headers: { cookie } });
    expect(page.status).toBe(401);
    expect(upstreamHits).toBe(0);
  });
});

describe("remote downloads via mobile hooks", () => {
  it("enforces session, Origin, and per-device canDownload permission", async () => {
    const cookie = await pairPhone(false);

    // No session -> 401
    expect((await fetch(url("/m/api/downloads"))).status).toBe(401);
    expect(
      (
        await fetch(url("/m/api/downloads"), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ mode: "account", account: "alice", kind: "both" }),
        })
      ).status,
    ).toBe(401);

    // Status GET works with session even when canDownload is false
    const statusRes = await fetch(url("/m/api/downloads"), { headers: { cookie } });
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    expect(statusJson.canDownload).toBe(false);

    // Device without flag -> 403
    const forbidden = await fetch(url("/m/api/downloads"), {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ mode: "account", account: "alice", kind: "both" }),
    });
    expect(forbidden.status).toBe(403);

    // Enable permission, then check bad Origin -> 403
    await setDeviceCanDownload(listDevices()[0]!.id, true);
    const badOrigin = await fetch(url("/m/api/downloads"), {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie, origin: "http://evil.example" },
      body: JSON.stringify({ mode: "account", account: "alice", kind: "both" }),
    });
    expect(badOrigin.status).toBe(403);
    expect(runnerMock.calls).toHaveLength(0);
  });

  it("rejects invalid handles, reserved folder names, and invalid post URLs with 400", async () => {
    const cookie = await pairPhone(true);
    const post = (body: unknown, contentType = "application/json") =>
      fetch(url("/m/api/downloads"), {
        method: "POST",
        headers: { ...JSON_HEADERS, "content-type": contentType, cookie },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    expect((await post({ mode: "account", account: "alice", kind: "both" }, "text/plain")).status).toBe(400);
    expect((await post("{bad json")).status).toBe(400);

    for (const badBody of [
      { mode: "account", account: "bad-handle", kind: "both" },
      { mode: "account", account: "a".repeat(16), kind: "both" },
      { mode: "account", account: "src", kind: "both" },
      { mode: "account", account: "docs", kind: "image" },
      { mode: "account", account: "con", kind: "video" },
      { mode: "account", account: "alice", kind: "all" },
      { mode: "account", account: "alice", kind: "both", extra: 1 },
      { mode: "post", url: "https://evil.com/alice/status/123" },
      { mode: "post", url: "https://x.com/i/status/123" },
      { mode: "post", url: "https://x.com/src/status/123" },
      { mode: "post", url: "https://x.com/alice/status/abc" },
      { mode: "post", url: "https://x.com/alice/media" },
    ]) {
      const res = await post(badBody);
      expect(res.status, JSON.stringify(badBody)).toBe(400);
    }
    expect(runnerMock.calls).toHaveLength(0);
  });

  it("enqueues whole-account image & video passes sequentially and exposes live status", async () => {
    const cookie = await pairPhone(true);
    const res = await fetch(url("/m/api/downloads"), {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ mode: "account", account: "@alice_art", kind: "both" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.runId).toMatch(/_alice_art$/);

    const finished = await queueModule.runQueue.waitFor(data.runId);
    expect(finished?.status).toBe("done");
    expect(finished?.remote).toBe(true);
    const stepCalls = runnerMock.calls.filter((argv) => !argv.includes("-j"));
    expect(stepCalls).toHaveLength(2);
    expect(stepCalls[0]).toContain("twitter.videos=false");
    expect(stepCalls[0]!.at(-1)).toBe("https://x.com/alice_art/media");
    expect(stepCalls[1]).toContain("twitter.videos=true");
    expect(stepCalls[1]!.at(-1)).toBe("https://x.com/alice_art/media");

    const statusRes = await fetch(url("/m/api/downloads"), { headers: { cookie } });
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    expect(statusJson.canDownload).toBe(true);
    const listed = statusJson.runs.find((entry: { id: string }) => entry.id === data.runId);
    expect(listed).toMatchObject({
      id: data.runId,
      account: "alice_art",
      status: "done",
      remote: true,
      counts: { saved: 4, skipped: 2, failed: 0 },
    });
    // Must not expose desktop paths or argv in mobile status.
    expect(JSON.stringify(listed)).not.toContain("galleryDlPath");
    expect(JSON.stringify(listed)).not.toContain("--cookies-from-browser");
  });

  it("enqueues single-post downloads with rebuilt canonical URL into <handle>/Image and <handle>/Video", async () => {
    const cookie = await pairPhone(true);
    const res = await fetch(url("/m/api/downloads"), {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({
        mode: "post",
        url: "https://mobile.twitter.com/alice_art/status/1834220145123456789?s=20&t=xyz",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const finished = await queueModule.runQueue.waitFor(data.runId);
    expect(finished?.status).toBe("done");
    expect(finished?.spec.postId).toBe("1834220145123456789");
    expect(runnerMock.calls).toHaveLength(2);
    expect(runnerMock.calls[0]).toContain('directory=["alice_art","Image"]');
    expect(runnerMock.calls[0]).toContain(`${mediaRoot}/alice_art/archive.sqlite3`);
    expect(runnerMock.calls[0]!.at(-1)).toBe("https://x.com/alice_art/status/1834220145123456789");
    expect(runnerMock.calls[1]).toContain('directory=["alice_art","Video"]');
    expect(runnerMock.calls[1]).toContain(`${mediaRoot}/alice_art/archive.sqlite3`);
    expect(runnerMock.calls[1]!.at(-1)).toBe("https://x.com/alice_art/status/1834220145123456789");
  });

  it("accepts the full desktop run form for every site and checks it like the desktop does", async () => {
    const cookie = await pairPhone(true);
    const start = (body: unknown) =>
      fetch(url("/m/api/downloads"), {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify(body),
      });
    const desktopSpec = {
      site: "instagram",
      account: "https://www.instagram.com/some.artist/",
      media: "images",
      layout: { kind: "byTypeYear" },
      simulate: false,
      advanced: { ...DEFAULT_ADVANCED, cookies: { browser: "firefox" } },
    };

    const res = await start({ mode: "run", spec: desktopSpec });
    expect(res.status).toBe(200);
    const data = await res.json();
    const finished = await queueModule.runQueue.waitFor(data.runId);
    expect(finished?.remote).toBe(true);
    expect(finished?.spec).toMatchObject({ site: "instagram", account: "some.artist", layout: { kind: "byTypeYear" } });
    const steps = runnerMock.calls.filter((argv) => !argv.includes("-j"));
    expect(steps.at(-1)!.at(-1)).toBe("https://www.instagram.com/some.artist/");

    for (const bad of [
      { ...desktopSpec, site: "myspace" },
      { ...desktopSpec, account: "https://x.com/not_instagram" },
      { ...desktopSpec, folder: "src" },
      { ...desktopSpec, site: "url", account: "ftp://example.com/" },
      { ...desktopSpec, postId: "123" },
    ]) {
      expect((await start({ mode: "run", spec: bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("queues a named-site account and an Other URL link from the share sheet", async () => {
    const cookie = await pairPhone(true);
    const start = (body: unknown) =>
      fetch(url("/m/api/downloads"), {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify(body),
      });

    const account = await (await start({ mode: "account", site: "reddit", account: "someone", kind: "image" })).json();
    expect((await queueModule.runQueue.waitFor(account.runId))?.spec).toMatchObject({ site: "reddit", account: "someone" });

    const link = await (await start({ mode: "link", url: "https://example.com/gallery/42", kind: "both" })).json();
    const linkRun = await queueModule.runQueue.waitFor(link.runId);
    expect(linkRun?.spec).toMatchObject({ site: "url", account: "https://example.com/gallery/42", media: "all" });

    expect((await start({ mode: "link", url: "javascript:alert(1)", kind: "both" })).status).toBe(400);
    expect((await start({ mode: "account", site: "url", account: "https://example.com/", kind: "both" })).status).toBe(400);
  });

  it("answers the account hint for a paired phone, even without download permission", async () => {
    expect((await fetch(url("/m/api/downloads/hint?site=x&account=alice"))).status).toBe(401);
    const cookie = await pairPhone(false);
    const hint = await fetch(url("/m/api/downloads/hint?site=x&account=new_person"), { headers: { cookie } });
    expect(hint.status).toBe(200);
    expect((await hint.json()).hint).toMatchObject({ kind: "new", folder: "new_person" });
    const reserved = await fetch(url("/m/api/downloads/hint?site=x&account=alice&folder=src"), { headers: { cookie } });
    expect((await reserved.json()).hint).toMatchObject({ kind: "reserved" });
    const junk = await fetch(url("/m/api/downloads/hint?site=nope&account=alice"), { headers: { cookie } });
    expect((await junk.json()).hint).toEqual({ kind: "empty" });
  });

  it("stops only phone-started runs via taskkill + .part cleanup, and refuses desktop runs", async () => {
    const cookie = await pairPhone(true);
    runnerMock.mode = "tree";

    // Enqueue a desktop run (remote not set) and verify the phone gets 403 trying to stop it.
    const desktopRun = await queueModule.runQueue.enqueue({
      site: "x",
      account: "desktop_acct",
      media: "images",
      layout: { kind: "byType" },
      simulate: false,
      advanced: { ...DEFAULT_ADVANCED },
    });
    const denyStop = await fetch(url("/m/api/downloads/stop"), {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ runId: desktopRun.id }),
    });
    expect(denyStop.status).toBe(403);
    await queueModule.runQueue.stop(desktopRun.id);

    // Now start a remote run with a .part file in its folder and stop it from the phone.
    const accountDir = join(mediaRoot, "remote_stop", "Image");
    await mkdir(accountDir, { recursive: true });
    await writeFile(join(accountDir, "1834220145_1.jpg.part"), "partial");

    const startRes = await fetch(url("/m/api/downloads"), {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ mode: "account", account: "remote_stop", kind: "image" }),
    });
    expect(startRes.status).toBe(200);
    const { runId } = (await startRes.json()) as { runId: string };

    // Wait briefly so the fake tree spawns before stopping.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const stopRes = await fetch(url("/m/api/downloads/stop"), {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ runId }),
    });
    expect(stopRes.status).toBe(200);

    const stoppedRun = await storeModule.getRun(runId);
    expect(stoppedRun?.status).toBe("stopped");
    expect(await readdir(accountDir)).toEqual([]);
  });
});
