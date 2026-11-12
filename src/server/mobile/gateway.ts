import "server-only";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isPrivatePeer, normalizeAddress } from "@/server/mobile/network";

export const SESSION_COOKIE = "gather_m";

export type RouteClass = "pair" | "logout" | "public" | "session" | "blocked";

const PUBLIC_EXACT = new Set(["/m/pair", "/manifest.webmanifest", "/m/sw.js"]);
const PUBLIC_PREFIXES = ["/_next/static/", "/m-icons/"];
const SESSION_EXACT = new Set(["/m", "/api/media", "/api/media/poster"]);
const SESSION_PREFIXES = ["/m/"];

/**
 * Decodes each path segment and rejects anything that could climb out of the allowlist ("..", encoded slashes,
 * backslashes, NUL). Returns null for a path that must be treated as blocked.
 */
export function safePathname(rawUrl: string | undefined): string | null {
  if (!rawUrl || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) return null;
  const path = rawUrl.split(/[?#]/, 1)[0];
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) return null;
  }
  return path;
}

export function classifyRoute(method: string | undefined, rawUrl: string | undefined): RouteClass {
  const path = safePathname(rawUrl);
  if (path === null) return "blocked";
  const verb = (method ?? "").toUpperCase();
  if (verb === "POST") {
    if (path === "/m/api/pair") return "pair";
    if (path === "/m/api/logout") return "logout";
    // The one read-only POST: the file names to put in a zip. It writes nothing on the PC.
    if (path === "/api/media/zip") return "session";
    return "blocked";
  }
  if (verb !== "GET" && verb !== "HEAD") return "blocked";
  if (PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) return "public";
  if (SESSION_EXACT.has(path) || SESSION_PREFIXES.some((prefix) => path.startsWith(prefix))) return "session";
  return "blocked";
}

/** A browser that sends an Origin on a POST must send the one that matches the address it is talking to. */
export function isSameOriginPost(headers: IncomingMessage["headers"]): boolean {
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// A phone must not be able to talk to the app as if it were the desktop window, so nothing that identifies
// the original client or carries the session crosses over.
function upstreamHeaders(incoming: IncomingMessage, upstreamPort: number): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (name === "host" || name === "cookie" || name === "origin" || name === "referer") continue;
    if (name.startsWith("x-gather-") || name.startsWith("x-forwarded-") || name === "forwarded") continue;
    headers[name] = value;
  }
  headers.host = `127.0.0.1:${upstreamPort}`;
  return headers;
}

// `next dev` evaluates code for its overlay and source maps; a production build does not.
const devEval = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${devEval}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy": CSP,
  };
}

function reply(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export interface GatewayHooks {
  /** True when the cookie value names a live paired phone. */
  authorize(sessionToken: string | null, peerIp: string): boolean;
  /** Handles `POST /m/api/pair`. Absent means pairing is not available and the route answers 404. */
  onPair?(req: IncomingMessage, res: ServerResponse): void;
  onLogout?(req: IncomingMessage, res: ServerResponse): void;
}

export interface GatewayOptions extends GatewayHooks {
  upstreamPort: number;
}

const MAX_POST_BYTES = 1024 * 1024;

function proxy(req: IncomingMessage, res: ServerResponse, upstreamPort: number): void {
  if (req.method === "POST" && Number(req.headers["content-length"] ?? 0) > MAX_POST_BYTES) {
    return reply(res, 413, "That request was too large.\n");
  }
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, upstreamPort),
    },
    (upstreamRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        headers[name] = value;
      }
      // The app never sets a cookie a phone should keep.
      delete headers["set-cookie"];
      Object.assign(headers, securityHeaders());
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );
  upstream.on("error", () => reply(res, 502, "The gallery server is not answering.\n"));
  // A phone that goes away mid-video must not leave a file stream open on the PC.
  res.on("close", () => upstream.destroy());
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (req.method === "POST" && received > MAX_POST_BYTES) {
      upstream.destroy();
      reply(res, 413, "That request was too large.\n");
      req.destroy();
    }
  });
  req.pipe(upstream);
}

export function peerOf(req: IncomingMessage): string {
  return normalizeAddress(req.socket.remoteAddress ?? "");
}

export function createGatewayHandler(options: GatewayOptions) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const route = classifyRoute(req.method, req.url);
    switch (route) {
      case "blocked":
        return reply(res, 404, "Not found.\n");
      case "pair":
        return options.onPair ? options.onPair(req, res) : reply(res, 404, "Not found.\n");
      case "logout":
        return options.onLogout ? options.onLogout(req, res) : reply(res, 404, "Not found.\n");
      case "session":
        if (req.method === "POST" && !isSameOriginPost(req.headers)) return reply(res, 403, "That request didn't come from this page.\n");
        if (!options.authorize(readSessionCookie(req.headers.cookie), peerOf(req))) {
          return reply(res, 401, "Pair this phone from grabberX on the PC first.\n");
        }
        return proxy(req, res, options.upstreamPort);
      case "public":
        return proxy(req, res, options.upstreamPort);
    }
  };
}

const MAX_CONNECTIONS_PER_PEER = 64;

export interface GatewayHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startGateway(options: GatewayOptions & { port: number; host?: string }): Promise<GatewayHandle> {
  const server = createServer(createGatewayHandler(options));
  server.headersTimeout = 15_000;
  server.requestTimeout = 0; // a long video stream is one request
  server.maxHeadersCount = 64;

  const perPeer = new Map<string, number>();
  server.on("connection", (socket: Socket) => {
    const peer = socket.remoteAddress ? normalizeAddress(socket.remoteAddress) : "";
    if (!isPrivatePeer(peer)) {
      socket.destroy();
      return;
    }
    const open = (perPeer.get(peer) ?? 0) + 1;
    if (open > MAX_CONNECTIONS_PER_PEER) {
      socket.destroy();
      return;
    }
    perPeer.set(peer, open);
    socket.on("close", () => {
      const left = (perPeer.get(peer) ?? 1) - 1;
      if (left <= 0) perPeer.delete(peer);
      else perPeer.set(peer, left);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
