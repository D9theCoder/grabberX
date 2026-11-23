import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGateway } from "@/server/mobile/gateway";
import type { GatewayHandle } from "@/server/mobile/gateway";
import { createPairingToken, resetPairingState } from "@/server/mobile/pairing";
import { revokeAllDevices } from "@/server/mobile/devices";
import { completeMeta, recordDuration, resetMediaIndexMemory } from "@/server/media-index";
import { resetOfflineDerivativeState } from "@/server/offline/derivatives";
import { resetEncoderCache } from "@/server/offline/encoder";
import { invalidateOfflineIndex, resetOfflineIndexCache } from "@/server/offline/index";
import { saveOfflineSettings } from "@/server/offline/settings";
import { resetFfmpegCache } from "@/server/video-poster";
import type { OfflineIndexResponse } from "@/lib/offline";

let sandbox = "";
let mediaRoot = "";
let upstream: Server;
let gateway: GatewayHandle;
let hooksModule: typeof import("@/server/mobile/hooks");

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-offline-index-"));
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "boot-home-"));
  mediaRoot = await mkdtemp(join(sandbox, "media-"));
  process.env.GATHER_MEDIA_ROOT = mediaRoot;
  hooksModule = await import("@/server/mobile/hooks");
});

beforeEach(async () => {
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "home-"));
  mediaRoot = await mkdtemp(join(sandbox, "media-run-"));
  process.env.GATHER_MEDIA_ROOT = mediaRoot;
  resetMediaIndexMemory();
  resetOfflineIndexCache();
  resetOfflineDerivativeState();
  resetEncoderCache();
  resetFfmpegCache();

  // Seed two accounts: acct_a (year-grouped images + video) and acct_b (flat image).
  const imgDirA = join(mediaRoot, "acct_a", "Image", "2025");
  const vidDirA = join(mediaRoot, "acct_a", "Video");
  const dirB = join(mediaRoot, "acct_b");
  await mkdir(imgDirA, { recursive: true });
  await mkdir(vidDirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await writeFile(join(mediaRoot, "acct_a", "archive.sqlite3"), "");
  await writeFile(join(mediaRoot, "acct_b", "archive.sqlite3"), "");

  const img1 = join(imgDirA, "1800000001_1.png");
  const img2 = join(dirB, "1900000001_1.png");
  const vid1 = join(vidDirA, "1800000002_1.mp4");
  await sharp({ create: { width: 640, height: 320, channels: 3, background: "#226688" } })
    .png()
    .toFile(img1);
  await sharp({ create: { width: 400, height: 400, channels: 3, background: "#884422" } })
    .png()
    .toFile(img2);
  await writeFile(vid1, Buffer.alloc(1024, 3));

  const img1Info = await stat(img1);
  await completeMeta(imgDirA, [
    { name: "1800000001_1.png", size: img1Info.size, mtimeMs: img1Info.mtimeMs, kind: "image" },
  ]);
  const vid1Info = await stat(vid1);
  await recordDuration(
    vidDirA,
    { name: "1800000002_1.mp4", size: vid1Info.size, mtimeMs: vid1Info.mtimeMs, kind: "video" },
    12.4,
  );

  upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>ok</p>");
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
  delete process.env.GATHER_FFMPEG;
  resetPairingState();
  await revokeAllDevices();
  await gateway.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  delete process.env.GATHER_MEDIA_ROOT;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

const url = (path: string) => `http://127.0.0.1:${gateway.port}${path}`;

async function pairPhone(): Promise<string> {
  const { token } = createPairingToken();
  const res = await fetch(url("/m/api/pair"), {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Android Chrome" },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

describe("offline index & thumb endpoints via gateway", () => {
  it("requires a session (401) and respects enabled=false default", async () => {
    expect((await fetch(url("/m/api/offline/index"))).status).toBe(401);
    expect((await fetch(url("/m/api/offline/thumb?account=acct_a&path=Image/2025/1800000001_1.png"))).status).toBe(401);

    const cookie = await pairPhone();
    const res = await fetch(url("/m/api/offline/index"), { headers: { cookie } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as OfflineIndexResponse;
    expect(data.enabled).toBe(false);
    expect(data.accounts).toEqual([]);
    expect(data.files).toEqual([]);

    const thumbDenied = await fetch(
      url("/m/api/offline/thumb?account=acct_a&path=Image/2025/1800000001_1.png"),
      { headers: { cookie } },
    );
    expect(thumbDenied.status).toBe(403);
  });

  it("returns expected shape with cached dimensions/durations, supports ETag 304 and incremental ?since sync", async () => {
    await saveOfflineSettings({ enabled: true, accounts: "all", includeImages: true, includeVideos: true });
    invalidateOfflineIndex();
    const cookie = await pairPhone();

    const first = await fetch(url("/m/api/offline/index"), { headers: { cookie } });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = (await first.json()) as OfflineIndexResponse;
    expect(body.enabled).toBe(true);
    expect(body.incremental).toBe(false);
    expect(body.accounts.map((a) => a.folder)).toEqual(["acct_a", "acct_b"]);
    expect(body.totalFiles).toBe(3);

    const imgFile = body.files.find((f) => f.filename === "1800000001_1.png");
    expect(imgFile).toMatchObject({
      id: "acct_a/Image/2025/1800000001_1.png",
      account: "acct_a",
      folder: "Image/2025",
      kind: "image",
      width: 640,
      height: 320,
    });
    const vidFile = body.files.find((f) => f.filename === "1800000002_1.mp4");
    expect(vidFile).toMatchObject({
      id: "acct_a/Video/1800000002_1.mp4",
      account: "acct_a",
      folder: "Video",
      kind: "video",
      duration: 12.4,
    });

    // Conditional request with matching ETag -> 304 Not Modified.
    const notMod = await fetch(url("/m/api/offline/index"), {
      headers: { cookie, "if-none-match": etag! },
    });
    expect(notMod.status).toBe(304);

    // Mutate disk: add one file to acct_a and remove acct_b's file.
    const added = join(mediaRoot, "acct_a", "Image", "2025", "1800000009_1.png");
    await sharp({ create: { width: 200, height: 100, channels: 3, background: "#00aa00" } })
      .png()
      .toFile(added);
    await unlink(join(mediaRoot, "acct_b", "1900000001_1.png"));
    invalidateOfflineIndex();

    const deltaRes = await fetch(url(`/m/api/offline/index?since=${encodeURIComponent(body.version)}`), {
      headers: { cookie },
    });
    expect(deltaRes.status).toBe(200);
    const delta = (await deltaRes.json()) as OfflineIndexResponse;
    expect(delta.incremental).toBe(true);
    expect(delta.version).not.toBe(body.version);
    expect(delta.files.map((f) => f.id)).toEqual(["acct_a/Image/2025/1800000009_1.png"]);
    expect(delta.removed).toEqual(["acct_b/1900000001_1.png"]);
    expect(delta.totalFiles).toBe(3);
  });

  it("filters index and thumb routes by included accounts and media kinds", async () => {
    await saveOfflineSettings({
      enabled: true,
      accounts: ["acct_a"],
      includeImages: true,
      includeVideos: false,
    });
    invalidateOfflineIndex();
    const cookie = await pairPhone();

    const res = await fetch(url("/m/api/offline/index"), { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OfflineIndexResponse;
    expect(body.accounts.map((a) => a.folder)).toEqual(["acct_a"]);
    expect(body.files.map((f) => f.id)).toEqual(["acct_a/Image/2025/1800000001_1.png"]);

    // Included image thumb succeeds as <= 320 px WebP and supports 304.
    const file = body.files[0]!;
    const thumbPath = `/m/api/offline/thumb?account=acct_a&path=${encodeURIComponent("Image/2025/1800000001_1.png")}&v=${file.v}`;
    const thumbRes = await fetch(url(thumbPath), { headers: { cookie } });
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers.get("content-type")).toBe("image/webp");
    expect(thumbRes.headers.get("cache-control")).toContain("immutable");
    const buf = Buffer.from(await thumbRes.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(320);

    const thumb304 = await fetch(url(thumbPath), {
      headers: { cookie, "if-none-match": thumbRes.headers.get("etag")! },
    });
    expect(thumb304.status).toBe(304);

    // Excluded account and excluded media kind are refused with 403.
    expect(
      (await fetch(url("/m/api/offline/thumb?account=acct_b&path=1900000001_1.png"), { headers: { cookie } })).status,
    ).toBe(403);
    expect(
      (await fetch(url("/m/api/offline/thumb?account=acct_a&path=Video/1800000002_1.mp4"), { headers: { cookie } })).status,
    ).toBe(403);
  });

  it("serves Layer 3 /m/api/offline/file with 401/403/202/200/304/Range and respects selection=newest", async () => {
    // Seed a second older image in acct_a so selection="newest" newestCount=1 excludes it.
    const olderImg = join(mediaRoot, "acct_a", "Image", "2025", "1700000000_1.png");
    await sharp({ create: { width: 300, height: 300, channels: 3, background: "#3333aa" } })
      .png()
      .toFile(olderImg);

    await saveOfflineSettings({
      enabled: true,
      accounts: ["acct_a"],
      includeImages: true,
      includeVideos: true,
      selection: "newest",
      newestCount: 2,
      image: { enabled: true, maxEdge: 2048, maxKB: 512, format: "webp", quality: 80 },
      video: { enabled: false },
      onlyWhenPluggedIn: false,
    });
    invalidateOfflineIndex();

    const filePath = `/m/api/offline/file?account=acct_a&path=${encodeURIComponent("Image/2025/1800000001_1.png")}`;
    // 401 without session
    expect((await fetch(url(filePath))).status).toBe(401);

    const cookie = await pairPhone();
    const idxRes = await fetch(url("/m/api/offline/index"), { headers: { cookie } });
    expect(idxRes.status).toBe(200);
    const idx = (await idxRes.json()) as OfflineIndexResponse;
    expect(idx.phoneBudgetBytes).toBe(2000 * 1024 * 1024);
    // Newest 2 in acct_a are 1800000002_1.mp4 and 1800000001_1.png; 1700000000_1.png is excluded.
    expect(idx.files.map((f) => f.filename).sort()).toEqual(["1800000001_1.png", "1800000002_1.mp4"]);

    const imgEntry = idx.files.find((f) => f.filename === "1800000001_1.png")!;
    expect(imgEntry.offline).toMatchObject({ ready: false });
    expect(imgEntry.offline!.bytes).toBeGreaterThan(0);
    // video.enabled is false -> video entry has no Layer 3 offline copy info.
    const vidEntry = idx.files.find((f) => f.filename === "1800000002_1.mp4")!;
    expect(vidEntry.offline).toBeUndefined();

    // 403 for excluded account, excluded older file, and video when video.enabled=false.
    expect((await fetch(url("/m/api/offline/file?account=acct_b&path=1900000001_1.png"), { headers: { cookie } })).status).toBe(403);
    expect((await fetch(url("/m/api/offline/file?account=acct_a&path=Image/2025/1700000000_1.png"), { headers: { cookie } })).status).toBe(403);
    expect((await fetch(url("/m/api/offline/file?account=acct_a&path=Video/1800000002_1.mp4"), { headers: { cookie } })).status).toBe(403);

    // First uncached request -> 202 with Retry-After and priority enqueue.
    const versionedUrl = `${filePath}&v=${encodeURIComponent(imgEntry.v)}`;
    const first = await fetch(url(versionedUrl), { headers: { cookie } });
    expect(first.status).toBe(202);
    expect(Number(first.headers.get("retry-after"))).toBeGreaterThan(0);

    // Poll briefly until prepared -> 200 with ETag, Accept-Ranges, immutable Cache-Control.
    let readyRes: Response | null = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const probe = await fetch(url(versionedUrl), { headers: { cookie } });
      if (probe.status === 200) {
        readyRes = probe;
        break;
      }
    }
    expect(readyRes).not.toBeNull();
    expect(readyRes!.headers.get("content-type")).toMatch(/^image\/(png|webp|jpeg)$/);
    expect(readyRes!.headers.get("accept-ranges")).toBe("bytes");
    expect(readyRes!.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const etag = readyRes!.headers.get("etag")!;
    const fullBody = Buffer.from(await readyRes!.arrayBuffer());
    expect(fullBody.length).toBe(Number(readyRes!.headers.get("content-length")));

    // HEAD returns headers and empty body.
    const headRes = await fetch(url(versionedUrl), { method: "HEAD", headers: { cookie } });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-length")).toBe(String(fullBody.length));
    expect((await headRes.arrayBuffer()).byteLength).toBe(0);

    // If-None-Match -> 304.
    const notMod = await fetch(url(versionedUrl), { headers: { cookie, "if-none-match": etag } });
    expect(notMod.status).toBe(304);

    // Range request -> 206 Partial Content; unsatisfiable range -> 416.
    const partial = await fetch(url(versionedUrl), { headers: { cookie, range: "bytes=0-31" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-31/${fullBody.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).equals(fullBody.subarray(0, 32))).toBe(true);

    const badRange = await fetch(url(versionedUrl), { headers: { cookie, range: "bytes=9999999-" } });
    expect(badRange.status).toBe(416);

    // Index now reports ready: true with exact prepared byte size via incremental ?since=.
    const deltaRes = await fetch(url(`/m/api/offline/index?since=${encodeURIComponent(idx.version)}`), {
      headers: { cookie },
    });
    expect(deltaRes.status).toBe(200);
    const delta = (await deltaRes.json()) as OfflineIndexResponse;
    expect(delta.incremental).toBe(true);
    const updatedImg = delta.files.find((f) => f.filename === "1800000001_1.png");
    expect(updatedImg?.offline).toMatchObject({ ready: true, bytes: fullBody.length });
  });
});
