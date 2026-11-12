import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGateway } from "@/server/mobile/gateway";
import type { GatewayHandle } from "@/server/mobile/gateway";
import { createMobileHooks, isSameSiteJsonPost } from "@/server/mobile/hooks";
import { createPairingToken, resetPairingState } from "@/server/mobile/pairing";
import { listDevices, revokeAllDevices } from "@/server/mobile/devices";

let sandbox = "";
let upstream: Server;
let gateway: GatewayHandle;
let upstreamHits = 0;

beforeEach(async () => {
  if (sandbox === "") sandbox = await mkdtemp(join(tmpdir(), "gather-hooks-"));
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "home-"));
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
    ...createMobileHooks(),
  });
});

afterEach(async () => {
  resetPairingState();
  await revokeAllDevices();
  await gateway.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

const url = (path: string) => `http://127.0.0.1:${gateway.port}${path}`;
const JSON_HEADERS = { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/130.0.0.0 Mobile" };
const pair = (token: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(url("/m/api/pair"), { method: "POST", headers, body: JSON.stringify({ token }) });

describe("isSameSiteJsonPost", () => {
  it("requires a JSON content type", () => {
    expect(isSameSiteJsonPost({ "content-type": "text/plain" })).toBe(false);
    expect(isSameSiteJsonPost({ "content-type": "application/x-www-form-urlencoded" })).toBe(false);
    expect(isSameSiteJsonPost({})).toBe(false);
    expect(isSameSiteJsonPost({ "content-type": "application/json" })).toBe(true);
  });
  it("requires an Origin that matches the Host when one is sent", () => {
    expect(isSameSiteJsonPost({ "content-type": "application/json", origin: "http://192.168.1.5:3211", host: "192.168.1.5:3211" })).toBe(true);
    expect(isSameSiteJsonPost({ "content-type": "application/json", origin: "http://evil.example", host: "192.168.1.5:3211" })).toBe(false);
    expect(isSameSiteJsonPost({ "content-type": "application/json", origin: "null", host: "192.168.1.5:3211" })).toBe(false);
  });
});

describe("pairing over HTTP", () => {
  it("trades a fresh code for an HttpOnly, SameSite=Strict session that opens the gallery", async () => {
    const { token } = createPairingToken();
    const res = await pair(token);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^gather_m=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
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
    const big = await fetch(url("/m/api/pair"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token: "a".repeat(5000) }) }).catch(
      () => null,
    );
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
