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
    expect(classifyRoute("GET", "/m/download")).toBe("session");
    expect(classifyRoute("GET", "/m/share?text=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1")).toBe("session");
    expect(classifyRoute("HEAD", "/api/media?account=a&path=b.jpg")).toBe("session");
    expect(classifyRoute("GET", "/api/media/poster?account=a&path=b.mp4")).toBe("blocked");
  });

  it("routes mobile download status and write endpoints separately from proxied pages", () => {
    expect(classifyRoute("GET", "/m/api/downloads")).toBe("downloads-status");
    expect(classifyRoute("HEAD", "/m/api/downloads")).toBe("downloads-status");
    expect(classifyRoute("POST", "/m/api/downloads")).toBe("downloads-start");
    expect(classifyRoute("POST", "/m/api/downloads/stop")).toBe("downloads-stop");
    expect(classifyRoute("DELETE", "/m/api/downloads")).toBe("blocked");
    expect(classifyRoute("PUT", "/m/api/downloads")).toBe("blocked");
    expect(classifyRoute("GET", "/m/api/pair")).toBe("blocked");
    expect(classifyRoute("GET", "/m/api/downloads/stop")).toBe("blocked");
    expect(classifyRoute("GET", "/m/api/downloads/hint?site=x&account=a")).toBe("downloads-hint");
    expect(classifyRoute("HEAD", "/m/api/downloads/hint")).toBe("downloads-hint");
    expect(classifyRoute("POST", "/m/api/downloads/hint")).toBe("blocked");
    expect(classifyRoute("GET", "/m/api/other")).toBe("blocked");
  });

  it("allows read-only offline index, offline thumb, offline file, and offline shell behind a session", () => {
    expect(classifyRoute("GET", "/m/offline")).toBe("session");
    expect(classifyRoute("GET", "/m/api/offline/index")).toBe("offline-index");
    expect(classifyRoute("HEAD", "/m/api/offline/index")).toBe("offline-index");
    expect(classifyRoute("GET", "/m/api/offline/index?since=abc")).toBe("offline-index");
    expect(classifyRoute("GET", "/m/api/offline/thumb?account=a&path=Image%2F1.jpg")).toBe("offline-thumb");
    expect(classifyRoute("HEAD", "/m/api/offline/thumb?account=a&path=Image%2F1.jpg")).toBe("offline-thumb");
    expect(classifyRoute("GET", "/m/api/offline/file?account=a&path=Image%2F1.jpg&v=1")).toBe("offline-file");
    expect(classifyRoute("HEAD", "/m/api/offline/file?account=a&path=Image%2F1.jpg&v=1")).toBe("offline-file");
    expect(classifyRoute("POST", "/m/api/offline/index")).toBe("blocked");
    expect(classifyRoute("POST", "/m/api/offline/thumb")).toBe("blocked");
    expect(classifyRoute("POST", "/m/api/offline/file")).toBe("blocked");
    expect(classifyRoute("DELETE", "/m/api/offline/file")).toBe("blocked");
    expect(classifyRoute("DELETE", "/m/api/offline/index")).toBe("blocked");
    expect(classifyRoute("GET", "/m/api/offline/unknown")).toBe("blocked");
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

  it("answers 404 for the pair, download, and offline routes while hooks are not wired", async () => {
    expect((await get("/m/api/pair", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await get("/m/api/downloads", { headers: { cookie: "gather_m=good" } })).status).toBe(404);
    expect((await get("/m/api/downloads", { method: "POST", headers: { cookie: "gather_m=good" }, body: "{}" })).status).toBe(404);
    expect((await get("/m/api/downloads/stop", { method: "POST", headers: { cookie: "gather_m=good" }, body: "{}" })).status).toBe(404);
    expect((await get("/m/api/offline/index", { headers: { cookie: "gather_m=good" } })).status).toBe(404);
    expect((await get("/m/api/offline/thumb?account=a&path=b.jpg", { headers: { cookie: "gather_m=good" } })).status).toBe(404);
    expect((await get("/m/api/offline/file?account=a&path=b.jpg", { headers: { cookie: "gather_m=good" } })).status).toBe(404);
  });

  it("requires a valid session on offline index, thumb, and file hooks", async () => {
    const upstreamPort = (upstream.address() as AddressInfo).port;
    let indexHits = 0;
    let thumbHits = 0;
    let fileHits = 0;
    const offlineGw = await startGateway({
      port: 0,
      host: "127.0.0.1",
      upstreamPort,
      authorize: (token) => token === "good",
      onOfflineIndex: (_req, res) => {
        indexHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      onOfflineThumb: (_req, res) => {
        thumbHits += 1;
        res.writeHead(200, { "content-type": "image/webp" });
        res.end(Buffer.from("webp"));
      },
      onOfflineFile: (_req, res) => {
        fileHits += 1;
        res.writeHead(200, { "content-type": "image/webp" });
        res.end(Buffer.from("full-copy"));
      },
    });
    try {
      const u = (p: string) => `http://127.0.0.1:${offlineGw.port}${p}`;
      expect((await fetch(u("/m/api/offline/index"))).status).toBe(401);
      expect((await fetch(u("/m/api/offline/thumb?account=a&path=1.jpg"))).status).toBe(401);
      expect((await fetch(u("/m/api/offline/file?account=a&path=1.jpg"))).status).toBe(401);
      expect(indexHits).toBe(0);
      expect(thumbHits).toBe(0);
      expect(fileHits).toBe(0);

      expect((await fetch(u("/m/api/offline/index"), { headers: { cookie: "gather_m=good" } })).status).toBe(200);
      expect((await fetch(u("/m/api/offline/thumb?account=a&path=1.jpg"), { headers: { cookie: "gather_m=good" } })).status).toBe(200);
      expect((await fetch(u("/m/api/offline/file?account=a&path=1.jpg"), { headers: { cookie: "gather_m=good" } })).status).toBe(200);
      expect(indexHits).toBe(1);
      expect(thumbHits).toBe(1);
      expect(fileHits).toBe(1);
    } finally {
      await offlineGw.close();
    }
  });

  it("enforces session, Origin, and canDownload on remote download hooks without leaking to upstream", async () => {
    const upstreamPort = (upstream.address() as AddressInfo).port;
    let allowDownload = false;
    let statusCalls = 0;
    let startCalls = 0;
    let stopCalls = 0;
    const dlGateway = await startGateway({
      port: 0,
      host: "127.0.0.1",
      upstreamPort,
      authorize: (token) => token === "good",
      canDownload: () => allowDownload,
      onDownloadsStatus: (_req, res) => {
        statusCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, canDownload: allowDownload, runs: [] }));
      },
      onDownloadStart: (_req, res) => {
        startCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      onDownloadStop: (_req, res) => {
        stopCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    });

    try {
      const dlUrl = (p: string) => `http://127.0.0.1:${dlGateway.port}${p}`;

      // Share page requires a valid session and strips cookie/origin when proxied.
      expect((await fetch(dlUrl("/m/share?text=hi"))).status).toBe(401);
      const shareOk = await fetch(dlUrl("/m/share?text=hi"), {
        headers: { cookie: "gather_m=good", origin: `http://127.0.0.1:${dlGateway.port}` },
      });
      expect(shareOk.status).toBe(200);
      await shareOk.text();
      expect(seen.at(-1)?.headers.cookie).toBeUndefined();
      expect(seen.at(-1)?.headers.origin).toBeUndefined();

      // Status GET: session-only, does not require canDownload.
      expect((await fetch(dlUrl("/m/api/downloads"))).status).toBe(401);
      const statusRes = await fetch(dlUrl("/m/api/downloads"), { headers: { cookie: "gather_m=good" } });
      expect(statusRes.status).toBe(200);
      expect(statusCalls).toBe(1);

      // Writes: bad Origin -> 403, missing session -> 401, canDownload false -> 403.
      expect(
        (
          await fetch(dlUrl("/m/api/downloads"), {
            method: "POST",
            headers: { cookie: "gather_m=good", origin: "http://evil.example", "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect((await fetch(dlUrl("/m/api/downloads"), { method: "POST", body: "{}" })).status).toBe(401);
      expect(
        (
          await fetch(dlUrl("/m/api/downloads"), {
            method: "POST",
            headers: { cookie: "gather_m=good", "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(dlUrl("/m/api/downloads/stop"), {
            method: "POST",
            headers: { cookie: "gather_m=good", "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(startCalls).toBe(0);
      expect(stopCalls).toBe(0);

      // With canDownload true and matching Origin -> succeeds.
      allowDownload = true;
      expect(
        (
          await fetch(dlUrl("/m/api/downloads"), {
            method: "POST",
            headers: {
              cookie: "gather_m=good",
              origin: `http://127.0.0.1:${dlGateway.port}`,
              "content-type": "application/json",
            },
            body: "{}",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(dlUrl("/m/api/downloads/stop"), {
            method: "POST",
            headers: {
              cookie: "gather_m=good",
              origin: `http://127.0.0.1:${dlGateway.port}`,
              "content-type": "application/json",
            },
            body: "{}",
          })
        ).status,
      ).toBe(200);
      expect(startCalls).toBe(1);
      expect(stopCalls).toBe(1);
    } finally {
      await dlGateway.close();
    }
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
    expect(classifyRoute("GET", "/m/ca.crt")).toBe("ca");
    const pair = await get("/m/pair");
    expect(pair.status).toBe(200);
    expect(await pair.text()).toBe("<p>page</p>");
    const asset = await get("/_next/static/chunks/a.js");
    expect(asset.status).toBe(200);
    await asset.arrayBuffer();
    const sw = await get("/m/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("service-worker-allowed")).toBe("/m");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    await sw.arrayBuffer();
  });

  it("serves both HTTP and HTTPS on the same port and downloads the Root CA at /m/ca.crt", async () => {
    const { generateRootCa, generateLeafCert } = await import("@/server/mobile/tls");
    const { get: httpsGet } = await import("node:https");
    const ca = generateRootCa();
    const leaf = generateLeafCert(ca, ["127.0.0.1"]);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const tlsGateway = await startGateway({
      port: 0,
      host: "127.0.0.1",
      upstreamPort,
      authorize: (token) => token === "good",
      tls: { key: leaf.keyPem, cert: leaf.certPem, caCertDer: ca.certDer },
    });

    try {
      const caRes = await fetch(`http://127.0.0.1:${tlsGateway.port}/m/ca.crt`);
      expect(caRes.status).toBe(200);
      expect(caRes.headers.get("content-type")).toBe("application/x-x509-ca-cert");
      expect(Buffer.from(await caRes.arrayBuffer()).equals(ca.certDer)).toBe(true);

      const httpsBody = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpsGet(
          {
            host: "127.0.0.1",
            port: tlsGateway.port,
            path: "/m",
            headers: { cookie: "gather_m=good" },
            ca: ca.certPem,
            rejectUnauthorized: true,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
      });
      expect(httpsBody).toEqual({ status: 200, text: "<p>page</p>" });

      const { connect: tlsConnect } = await import("node:tls");
      const tlsResponse = await new Promise<{ authorized: boolean; statusLine: string }>((resolve, reject) => {
        const sock = tlsConnect({ host: "127.0.0.1", port: tlsGateway.port, ca: ca.certPem, rejectUnauthorized: true }, () => {
          sock.write("GET /m/pair HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        const chunks: Buffer[] = [];
        sock.on("data", (chunk: Buffer) => chunks.push(chunk));
        sock.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ authorized: sock.authorized, statusLine: text.split("\r\n", 1)[0] ?? "" });
        });
        sock.on("error", reject);
      });
      expect(tlsResponse).toEqual({ authorized: true, statusLine: "HTTP/1.1 200 OK" });

      const httpPair = await fetch(`http://127.0.0.1:${tlsGateway.port}/m/pair`);
      expect(httpPair.status).toBe(200);
      expect(await httpPair.text()).toBe("<p>page</p>");
    } finally {
      await tlsGateway.close();
    }
  });

  it("handles fragmented first bytes, refreshes leaf SANs dynamically via ensureHost, and releases peer slots after TLS errors", async () => {
    const { generateRootCa, generateLeafCert } = await import("@/server/mobile/tls");
    const { connect: netConnect } = await import("node:net");
    const { connect: tlsConnect } = await import("node:tls");
    const ca = generateRootCa();
    const initialLeaf = generateLeafCert(ca, []);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const ensuredHosts: string[] = [];
    const knownHosts = new Set<string>();

    const tlsGateway = await startGateway({
      port: 0,
      host: "127.0.0.1",
      upstreamPort,
      authorize: (token) => token === "good",
      tls: {
        key: initialLeaf.keyPem,
        cert: initialLeaf.certPem,
        caCertDer: ca.certDer,
        ensureHost: (localIp) => {
          if (knownHosts.has(localIp)) return null;
          knownHosts.add(localIp);
          ensuredHosts.push(localIp);
          const refreshed = generateLeafCert(ca, [...knownHosts]);
          return { key: refreshed.keyPem, cert: refreshed.certPem };
        },
      },
    });

    try {
      // Split HTTP request at byte 1 across pauseOnConnect + unshift.
      const splitHttp = await new Promise<string>((resolve, reject) => {
        const sock = netConnect(tlsGateway.port, "127.0.0.1", () => {
          sock.write("G");
          setTimeout(() => sock.write("ET /m/pair HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"), 20);
        });
        const chunks: Buffer[] = [];
        sock.on("data", (chunk: Buffer) => chunks.push(chunk));
        sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        sock.on("error", reject);
      });
      expect(splitHttp).toContain("HTTP/1.1 200 OK");
      expect(splitHttp).toContain("<p>page</p>");

      // Repeated failed TLS handshakes (> MAX_CONNECTIONS_PER_PEER) and early closes must not leak perPeer slots.
      for (let i = 0; i < 70; i++) {
        await new Promise<void>((resolve) => {
          const bad = tlsConnect({ host: "127.0.0.1", port: tlsGateway.port, rejectUnauthorized: true }, () => bad.destroy());
          bad.on("error", () => resolve());
          bad.on("close", () => resolve());
        });
      }
      for (let i = 0; i < 70; i++) {
        await new Promise<void>((resolve) => {
          const empty = netConnect(tlsGateway.port, "127.0.0.1", () => empty.end());
          empty.on("close", () => resolve());
          empty.on("error", () => resolve());
        });
      }

      const okAfterErrors = await new Promise<{ authorized: boolean; body: string; san: string }>((resolve, reject) => {
        let san = "";
        const sock = tlsConnect({ host: "127.0.0.1", port: tlsGateway.port, ca: ca.certPem, rejectUnauthorized: true }, () => {
          san = sock.getPeerCertificate().subjectaltname ?? "";
          sock.write("GET /m/pair HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        const chunks: Buffer[] = [];
        sock.on("data", (chunk: Buffer) => chunks.push(chunk));
        sock.on("end", () =>
          resolve({ authorized: sock.authorized, body: Buffer.concat(chunks).toString("utf8"), san }),
        );
        sock.on("error", reject);
      });
      expect(okAfterErrors.authorized).toBe(true);
      expect(okAfterErrors.body).toContain("<p>page</p>");
      expect(ensuredHosts).toContain("127.0.0.1");
      expect(okAfterErrors.san).toContain("IP Address:127.0.0.1");

      const rotated = generateLeafCert(ca, ["100.64.9.9"]);
      tlsGateway.setTlsContext?.({ key: rotated.keyPem, cert: rotated.certPem });
      const rotatedSan = await new Promise<string>((resolve, reject) => {
        const sock = tlsConnect({ host: "127.0.0.1", port: tlsGateway.port, ca: ca.certPem, rejectUnauthorized: true }, () => {
          const san = sock.getPeerCertificate().subjectaltname ?? "";
          sock.end();
          resolve(san);
        });
        sock.on("error", reject);
      });
      expect(rotatedSan).toContain("IP Address:100.64.9.9");
    } finally {
      await tlsGateway.close();
    }
  });

  it("reports a 502 when the app is down", async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const res = await get("/m", { headers: { cookie: "gather_m=good" } });
    expect(res.status).toBe(502);
    upstream = createServer();
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });
});
