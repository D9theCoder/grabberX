import "server-only";
import type { IncomingMessage, ServerResponse } from "node:http";
import { peerOf, readSessionCookie, SESSION_COOKIE, securityHeaders } from "@/server/mobile/gateway";
import type { GatewayHooks } from "@/server/mobile/gateway";
import { authorizeSession, createDevice, DeviceLimitError, revokeSession } from "@/server/mobile/devices";
import { consumePairingToken } from "@/server/mobile/pairing";
import { classifyPeer } from "@/server/mobile/network";

const MAX_BODY_BYTES = 1024;
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 3600;

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/**
 * A cross-site form cannot send application/json without a preflight, and a browser that does send an Origin
 * must send the one that matches the address it is talking to.
 */
export function isSameSiteJsonPost(headers: IncomingMessage["headers"]): boolean {
  if (!(headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

const CLEAR_COOKIE = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

// The header is only believed from a proxy on this PC (Tailscale Serve), never from a phone on the LAN.
function cameOverHttps(req: IncomingMessage): boolean {
  return classifyPeer(peerOf(req)) === "loopback" && req.headers["x-forwarded-proto"] === "https";
}

async function onPair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isSameSiteJsonPost(req.headers)) return json(res, 400, { ok: false, error: "That request wasn't valid." });
  const raw = await readBody(req);
  if (raw === null) return json(res, 413, { ok: false, error: "That request was too large." });
  let token: unknown;
  try {
    token = (JSON.parse(raw) as { token?: unknown }).token;
  } catch {
    return json(res, 400, { ok: false, error: "That request wasn't valid." });
  }

  const ip = peerOf(req);
  const result = consumePairingToken(token, ip);
  if (!result.ok) {
    if (result.reason === "limited") {
      return json(
        res,
        429,
        { ok: false, error: "Too many tries. Wait a few minutes, then make a new code on the PC." },
        { "retry-after": String(result.retryAfterSeconds) },
      );
    }
    // The same answer for a wrong, expired and used code, so a guesser learns nothing.
    return json(res, 401, { ok: false, error: "That code didn't work. Make a new one on the PC." });
  }

  try {
    const { token: session } = await createDevice({ userAgent: String(req.headers["user-agent"] ?? ""), ip });
    json(res, 200, { ok: true }, { "set-cookie": sessionCookie(session, cameOverHttps(req)) });
  } catch (error) {
    if (error instanceof DeviceLimitError) return json(res, 409, { ok: false, error: error.message });
    console.error("grabberX: could not pair a phone.", error);
    json(res, 500, { ok: false, error: "Pairing failed. Try again." });
  }
}

async function onLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isSameSiteJsonPost(req.headers)) return json(res, 400, { ok: false, error: "That request wasn't valid." });
  await revokeSession(readSessionCookie(req.headers.cookie)).catch(() => false);
  json(res, 200, { ok: true }, { "set-cookie": CLEAR_COOKIE });
}

export function createMobileHooks(): GatewayHooks {
  return {
    authorize: (token, ip) => authorizeSession(token, ip),
    onPair: (req, res) => void onPair(req, res),
    onLogout: (req, res) => void onLogout(req, res),
  };
}
