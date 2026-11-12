import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyRoute, readSessionCookie, safePathname, startGateway } from "@/server/mobile/gateway";
import type { GatewayHandle } from "@/server/mobile/gateway";

describe("safePathname", () => {
  it.each([
    ["/m", "/m"],
    ["/m/pair?x=1", "/m/pair"],
    ["/api/media?account=a&path=b%2Fc.jpg", "/api/media"],
    ["/m/%E6%97%A5%E6%9C%AC", "/m/%E6%97%A5%E6%9C%AC"],
  ])("accepts %s", (raw, expected) => {
    expect(safePathname(raw)).toBe(expected);
  });

  it.each([
    "",
    "m",
    "//evil.example/m",
    "/m/../settings",
    "/m/%2e%2e/settings",
    "/m/%2E%2E/settings",
    "/m/a%2Fb",
    "/m/a%5Cb",
    "/m/a\\b",
    "/m/%00",
    "/m/%zz",
    "/m/./x",
  ])("rejects %j", (raw) => {
    expect(safePathname(raw)).toBeNull();
  });
});

describe("classifyRoute", () => {
  it("lets the mobile pages and media through behind a session", () => {
    expect(classifyRoute("GET", "/m")).toBe("session");
    expect(classifyRoute("GET", "/m/acct/Image")).toBe("session");
    expect(classifyRoute("HEAD", "/api/media?account=a&path=b.jpg")).toBe("session");
    expect(classifyRoute("GET", "/api/media/poster?account=a&path=b.mp4")).toBe("session");
  });

  it("serves only the pairing page and static assets without a session", () => {
    expect(classifyRoute("GET", "/m/pair")).toBe("public");
    expect(classifyRoute("GET", "/_next/static/chunks/app.js")).toBe("public");
    expect(classifyRoute("GET", "/manifest.webmanifest")).toBe("public");
    expect(classifyRoute("GET", "/m/sw.js")).toBe("public");
  });

  it("lets only the zip request through as a POST, behind a session", () => {
    expect(classifyRoute("POST", "/api/media/zip")).toBe("session");
    expect(classifyRoute("GET", "/api/media/zip")).toBe("blocked");
    expect(classifyRoute("POST", "/api/media/dims")).toBe("blocked");
    expect(classifyRoute("PUT", "/api/media/zip")).toBe("blocked");
  });

  it("answers the two POST routes itself", () => {
    expect(classifyRoute("POST", "/m/api/pair")).toBe("pair");
    expect(classifyRoute("POST", "/m/api/logout")).toBe("logout");
  });

  it.each([
    ["GET", "/"],
    ["GET", "/library"],
    ["GET", "/library/someone"],
    ["GET", "/history"],
    ["GET", "/settings"],
    ["GET", "/welcome"],
    ["GET", "/api/runs"],
    ["GET", "/api/runs/abc/events"],
    ["GET", "/api/open-folder"],
    ["GET", "/api/health"],
    ["GET", "/_next/image?url=%2Fx"],
    ["GET", "/_next/data/x.json"],
    ["GET", "/mobile"],
    ["GET", "/api/media/other"],
  ])("blocks %s %s", (method, url) => {
    expect(classifyRoute(method, url)).toBe("blocked");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("blocks %s on the media and page routes", (method) => {
    expect(classifyRoute(method, "/api/media")).toBe("blocked");
    expect(classifyRoute(method, "/m")).toBe("blocked");
    expect(classifyRoute(method, "/m/acct")).toBe("blocked");
  });

  it("blocks a Server Action call on a mobile page", () => {
    expect(classifyRoute("POST", "/m")).toBe("blocked");
    expect(classifyRoute("POST", "/m/acct/Image")).toBe("blocked");
  });
});

describe("readSessionCookie", () => {
  it("finds the cookie among others", () => {
    expect(readSessionCookie("a=1; gather_m=abc123; b=2")).toBe("abc123");
  });
  it("returns null when it is absent or empty", () => {
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie("a=1")).toBeNull();
    expect(readSessionCookie("gather_m=")).toBeNull();
    expect(readSessionCookie("xgather_m=abc")).toBeNull();
  });
});

describe("the running gateway", () => {
  let upstream: Server;
  let gateway: GatewayHandle;
  let seen: { url?: string; method?: string; headers: IncomingHttpHeaders }[];
  const VIDEO = Buffer.from("0123456789".repeat(10));

  beforeEach(async () => {
    seen = [];
    upstream = createServer((req, res) => {
      seen.push({ url: req.url, method: req.method, headers: req.headers });
      if (req.url?.startsWith("/api/media")) {
        const range = req.headers.range;
        if (range === "bytes=10-19") {
          res.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 10-19/100", "set-cookie": "leak=1" });
          res.end(VIDEO.subarray(10, 20));
          return;
        }
        res.writeHead(200, { "content-type": "video/mp4", "content-length": String(VIDEO.length) });
        res.end(VIDEO);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>page</p>");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    gateway = await startGateway({
      port: 0,
      host: "127.0.0.1",
      upstreamPort,
      authorize: (token) => token === "good",
    });
  });

  afterEach(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${gateway.port}${path}`, init);

  it("refuses a session route without a cookie and never reaches the app", async () => {
    const res = await get("/api/media?account=a&path=b.mp4");
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses a wrong cookie", async () => {
    const res = await get("/m", { headers: { cookie: "gather_m=bad" } });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("answers 404 for desktop routes, even with a valid session", async () => {
    for (const path of ["/", "/settings", "/library", "/api/runs", "/api/open-folder", "/m/../settings"]) {
      const res = await get(path, { headers: { cookie: "gather_m=good" } });
      expect(res.status, path).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("answers 404 for writes, even with a valid session", async () => {
    for (const path of ["/api/media", "/m", "/m/acct", "/api/media/poster"]) {
      const res = await get(path, { method: "POST", body: "x", headers: { cookie: "gather_m=good" } });
      expect(res.status, path).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("forwards the zip request for a paired phone, and only from its own page", async () => {
    const body = new URLSearchParams({ account: "a", path: "Image", name: "x.png" });
    const post = (headers: Record<string, string>) =>
      get("/api/media/zip", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });

    expect((await post({})).status).toBe(401);
    expect(
      (await post({ cookie: "gather_m=good", origin: "http://evil.example" })).status,
    ).toBe(403);
    expect(seen).toHaveLength(0);

    const ok = await post({ cookie: "gather_m=good", origin: `http://127.0.0.1:${gateway.port}` });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.origin).toBeUndefined();
    expect(seen[0].headers.cookie).toBeUndefined();
  });

  it("refuses an oversized zip request", async () => {
    const res = await get("/api/media/zip", {
      method: "POST",
      body: "x".repeat(2 * 1024 * 1024),
      headers: { "content-type": "text/plain", cookie: "gather_m=good" },
    }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
    expect(seen.filter((entry) => entry.method === "POST")).toHaveLength(0);
  });

  it("answers 404 for the pair route while pairing is not wired", async () => {
    const res = await get("/m/api/pair", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("forwards media for a paired phone with Range intact, without the cookie or a forwarded host", async () => {
    const res = await get("/api/media?account=a&path=b.mp4", {
      headers: { cookie: "gather_m=good", range: "bytes=10-19", "x-forwarded-for": "1.2.3.4", "x-gather-admin": "1" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("0123456789");
    expect(seen).toHaveLength(1);
    const headers = seen[0].headers;
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
    expect(headers["x-gather-admin"]).toBeUndefined();
    expect(headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(headers.range).toBe("bytes=10-19");
  });

  it("adds security headers and drops set-cookie from the app", async () => {
    const res = await get("/api/media?account=a&path=b.mp4", { headers: { cookie: "gather_m=good", range: "bytes=10-19" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await res.arrayBuffer();
  });

  it("serves the pairing page and static assets without a cookie", async () => {
    const pair = await get("/m/pair");
    expect(pair.status).toBe(200);
    expect(await pair.text()).toBe("<p>page</p>");
    const asset = await get("/_next/static/chunks/a.js");
    expect(asset.status).toBe(200);
    await asset.arrayBuffer();
  });

  it("reports a 502 when the app is down", async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const res = await get("/m", { headers: { cookie: "gather_m=good" } });
    expect(res.status).toBe(502);
    upstream = createServer();
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });
});
