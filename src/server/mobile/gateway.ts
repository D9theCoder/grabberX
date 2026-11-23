import "server-only";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import type { Server, Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { isPrivatePeer, normalizeAddress } from "@/server/mobile/network";

export const SESSION_COOKIE = "gather_m";

export type RouteClass =
  | "pair"
  | "logout"
  | "downloads-status"
  | "downloads-hint"
  | "downloads-start"
  | "downloads-stop"
  | "offline-index"
  | "offline-thumb"
  | "offline-file"
  | "ca"
  | "public"
  | "session"
  | "blocked";

const PUBLIC_EXACT = new Set(["/m/pair", "/manifest.webmanifest", "/m/sw.js"]);
const PUBLIC_PREFIXES = ["/_next/static/", "/m-icons/"];
const SESSION_EXACT = new Set(["/m", "/api/media"]);
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
    if (path === "/m/api/downloads") return "downloads-start";
    if (path === "/m/api/downloads/stop") return "downloads-stop";
    // The one read-only POST: the file names to put in a zip. It writes nothing on the PC.
    if (path === "/api/media/zip") return "session";
    return "blocked";
  }
  if (verb !== "GET" && verb !== "HEAD") return "blocked";
  if (path === "/m/ca.crt") return "ca";
  if (path === "/m/api/downloads") return "downloads-status";
  if (path === "/m/api/downloads/hint") return "downloads-hint";
  if (path === "/m/api/offline/index") return "offline-index";
  if (path === "/m/api/offline/thumb") return "offline-thumb";
  if (path === "/m/api/offline/file") return "offline-file";
  if (path.startsWith("/m/api/")) return "blocked";
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

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export interface GatewayTlsOptions {
  key: string;
  cert: string;
  caCertDer?: Buffer;
  ensureHost?: (localAddress: string) => { key: string; cert: string } | null;
}

export interface GatewayHooks {
  /** True when the cookie value names a live paired phone. */
  authorize(sessionToken: string | null, peerIp: string): boolean;
  /** True when the paired phone is opted into starting and stopping remote downloads on the PC. */
  canDownload?(sessionToken: string | null): boolean;
  /** Handles `POST /m/api/pair`. Absent means pairing is not available and the route answers 404. */
  onPair?(req: IncomingMessage, res: ServerResponse): void;
  onLogout?(req: IncomingMessage, res: ServerResponse): void;
  onDownloadsStatus?(req: IncomingMessage, res: ServerResponse): void;
  /** Read-only: what the desktop Run form says about an account (new, already in the library, reserved). */
  onDownloadHint?(req: IncomingMessage, res: ServerResponse): void;
  onDownloadStart?(req: IncomingMessage, res: ServerResponse): void;
  onDownloadStop?(req: IncomingMessage, res: ServerResponse): void;
  onOfflineIndex?(req: IncomingMessage, res: ServerResponse): void;
  onOfflineThumb?(req: IncomingMessage, res: ServerResponse): void;
  onOfflineFile?(req: IncomingMessage, res: ServerResponse): void;
  /** Optional DER-encoded local Root CA certificate served at `GET /m/ca.crt` so Android can trust LAN HTTPS. */
  caCertDer?: Buffer;
}

export interface GatewayOptions extends GatewayHooks {
  upstreamPort: number;
  tls?: GatewayTlsOptions;
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
      if (safePathname(req.url) === "/m/sw.js") {
        headers["service-worker-allowed"] = "/m";
        headers["cache-control"] = "no-cache";
      }
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

function serveCaCert(req: IncomingMessage, res: ServerResponse, caCertDer: Buffer | undefined): void {
  if (!caCertDer) return reply(res, 404, "Not found.\n");
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "application/x-x509-ca-cert",
    "content-disposition": 'attachment; filename="grabberX-root-ca.crt"',
    "content-length": String(caCertDer.length),
    "cache-control": "no-store",
  });
  if ((req.method ?? "GET").toUpperCase() === "HEAD") {
    res.end();
    return;
  }
  res.end(caCertDer);
}

export function createGatewayHandler(options: GatewayOptions) {
  const caCertDer = options.caCertDer ?? options.tls?.caCertDer;
  return (req: IncomingMessage, res: ServerResponse): void => {
    const route = classifyRoute(req.method, req.url);
    switch (route) {
      case "blocked":
        return reply(res, 404, "Not found.\n");
      case "ca":
        return serveCaCert(req, res, caCertDer);
      case "pair":
        return options.onPair ? options.onPair(req, res) : reply(res, 404, "Not found.\n");
      case "logout":
        return options.onLogout ? options.onLogout(req, res) : reply(res, 404, "Not found.\n");
      case "downloads-status":
      case "downloads-hint": {
        const handler = route === "downloads-status" ? options.onDownloadsStatus : options.onDownloadHint;
        if (!handler) return reply(res, 404, "Not found.\n");
        const token = readSessionCookie(req.headers.cookie);
        if (!options.authorize(token, peerOf(req))) {
          return replyJson(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
        }
        return handler(req, res);
      }
      case "offline-index": {
        if (!options.onOfflineIndex) return reply(res, 404, "Not found.\n");
        const token = readSessionCookie(req.headers.cookie);
        if (!options.authorize(token, peerOf(req))) {
          return replyJson(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
        }
        return options.onOfflineIndex(req, res);
      }
      case "offline-thumb": {
        if (!options.onOfflineThumb) return reply(res, 404, "Not found.\n");
        const token = readSessionCookie(req.headers.cookie);
        if (!options.authorize(token, peerOf(req))) {
          return replyJson(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
        }
        return options.onOfflineThumb(req, res);
      }
      case "offline-file": {
        if (!options.onOfflineFile) return reply(res, 404, "Not found.\n");
        const token = readSessionCookie(req.headers.cookie);
        if (!options.authorize(token, peerOf(req))) {
          return replyJson(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
        }
        return options.onOfflineFile(req, res);
      }
      case "downloads-start":
      case "downloads-stop": {
        const handler = route === "downloads-start" ? options.onDownloadStart : options.onDownloadStop;
        if (!handler) return reply(res, 404, "Not found.\n");
        if (!isSameOriginPost(req.headers)) {
          return replyJson(res, 403, { ok: false, error: "That request didn't come from this page." });
        }
        const token = readSessionCookie(req.headers.cookie);
        if (!options.authorize(token, peerOf(req))) {
          return replyJson(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
        }
        if (!options.canDownload?.(token)) {
          return replyJson(res, 403, {
            ok: false,
            error: "Downloads are turned off for this phone. Turn on \"Can start downloads\" for this phone in grabberX on the PC.",
          });
        }
        return handler(req, res);
      }
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
  setTlsContext?(tls: { key: string; cert: string }): void;
  close(): Promise<void>;
}

function configureHttpLimits(httpServer: HttpServer): void {
  httpServer.headersTimeout = 15_000;
  httpServer.requestTimeout = 0; // a long video stream is one request
  httpServer.maxHeadersCount = 64;
}

export function startGateway(options: GatewayOptions & { port: number; host?: string }): Promise<GatewayHandle> {
  const handler = createGatewayHandler(options);
  const httpServer = createHttpServer(handler);
  configureHttpLimits(httpServer);

  const httpsServer = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : null;
  if (httpsServer) {
    configureHttpLimits(httpsServer);
    httpsServer.on("tlsClientError", (_err, tlsSocket: TLSSocket) => {
      tlsSocket.destroy();
    });
  }

  const activeSockets = new Set<Socket>();
  const perPeer = new Map<string, number>();

  // If TLS is configured, a net.Server sniffs the first byte on each socket: 0x16 (TLS Handshake) goes to
  // httpsServer and plain ASCII HTTP verbs go to httpServer, so both http:// and https:// work on the same port.
  const server: Server = httpsServer
    ? createNetServer({ pauseOnConnect: true }, (socket: Socket) => {
        if (!acceptSocket(socket)) return;
        const cleanup = () => {
          clearTimeout(sniffTimer);
          socket.removeListener("readable", onReadable);
          socket.removeListener("error", onError);
          socket.removeListener("close", cleanup);
        };
        const onReadable = () => {
          const chunk = socket.read(1) as Buffer | null;
          if (!chunk) return;
          cleanup();
          const firstByte = chunk[0];
          socket.unshift(chunk);
          if (firstByte === 0x16) {
            const localIp = socket.localAddress ? normalizeAddress(socket.localAddress) : "";
            const updated = localIp ? options.tls?.ensureHost?.(localIp) : null;
            if (updated) httpsServer.setSecureContext({ key: updated.key, cert: updated.cert });
            httpsServer.emit("connection", socket);
          } else {
            httpServer.emit("connection", socket);
          }
        };
        const onError = () => {
          cleanup();
          socket.destroy();
        };
        const sniffTimer = setTimeout(() => {
          cleanup();
          socket.destroy();
        }, 10_000);
        sniffTimer.unref();
        socket.on("readable", onReadable);
        socket.on("error", onError);
        socket.once("close", cleanup);
      })
    : httpServer;

  function acceptSocket(socket: Socket): boolean {
    const peer = socket.remoteAddress ? normalizeAddress(socket.remoteAddress) : "";
    if (!isPrivatePeer(peer)) {
      socket.destroy();
      return false;
    }
    const open = (perPeer.get(peer) ?? 0) + 1;
    if (open > MAX_CONNECTIONS_PER_PEER) {
      socket.destroy();
      return false;
    }
    perPeer.set(peer, open);
    activeSockets.add(socket);
    socket.on("close", () => {
      activeSockets.delete(socket);
      const left = (perPeer.get(peer) ?? 1) - 1;
      if (left <= 0) perPeer.delete(peer);
      else perPeer.set(peer, left);
    });
    return true;
  }

  if (!httpsServer) {
    httpServer.on("connection", (socket: Socket) => {
      acceptSocket(socket);
    });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        server,
        port,
        setTlsContext: httpsServer
          ? (tls) => {
              httpsServer.setSecureContext({ key: tls.key, cert: tls.cert });
            }
          : undefined,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            httpServer.closeAllConnections();
            httpsServer?.closeAllConnections();
            for (const sock of activeSockets) sock.destroy();
          }),
      });
    });
  });
}

