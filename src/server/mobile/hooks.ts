import "server-only";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isSameOriginPost,
  peerOf,
  readSessionCookie,
  SESSION_COOKIE,
  securityHeaders,
} from "@/server/mobile/gateway";
import type { GatewayHooks } from "@/server/mobile/gateway";
import {
  authorizeSession,
  canDeviceDownload,
  createDevice,
  DeviceLimitError,
  revokeSession,
} from "@/server/mobile/devices";
import { consumePairingToken } from "@/server/mobile/pairing";
import { classifyPeer } from "@/server/mobile/network";
import { mediaKindOf } from "@/components/gallery/types";
import { isAccountIncluded, isCopyEnabledForKind, isKindIncluded, presetIdForKind } from "@/lib/offline";
import {
  KIND_TO_MEDIA,
  remoteDownloadRequestSchema,
  remoteStopRequestSchema,
} from "@/lib/mobile-downloads";
import type { MobileRunSummary } from "@/lib/mobile-downloads";
import { compareRunIds } from "@/lib/run-order";
import { endMessage } from "@/lib/run-copy";
import { folderNameFor } from "@/lib/sites";
import { createDefaultSpec, DEFAULT_ADVANCED } from "@/lib/spec";
import type { Run } from "@/lib/spec";
import { parseXPostUrl } from "@/lib/x-url";
import { etagOf, MediaPathError, parseRange, statMediaFile } from "@/server/media";
import {
  enqueueOfflineDerivative,
  getCachedOfflineDerivative,
  getOfflineDerivativeScheduler,
} from "@/server/offline/derivatives";
import { getOfflineEncoderStatus } from "@/server/offline/encoder";
import { buildOfflineIndex, isFileInOfflineSelection } from "@/server/offline/index";
import { getOfflineSettings } from "@/server/offline/settings";
import { getOfflineThumbnail } from "@/server/offline/thumbs";
import { getAccountHint } from "@/server/library";
import { runQueue } from "@/server/run-queue";
import { accountHintInput, prepareRunSpec } from "@/server/run-request";
import { getRun, getSettings, isValidRunId, listRuns } from "@/server/store";

const MAX_BODY_BYTES = 1024;
const MAX_DOWNLOAD_BODY_BYTES = 16 * 1024;
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 3600;
const STATUS_RUN_LIMIT = 20;

const DOWNLOAD_FORBIDDEN_MESSAGE =
  "Downloads are turned off for this phone. Turn on \"Can start downloads\" for this phone in grabberX on the PC.";

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string | string[]> = {},
  headOnly = false,
): void {
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      finish(null);
      req.destroy();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

/**
 * A cross-site form cannot send application/json without a preflight, and a browser that does send an Origin
 * must send the one that matches the address it is talking to.
 */
export function isSameSiteJsonPost(headers: IncomingMessage["headers"]): boolean {
  if (!(headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return false;
  return isSameOriginPost(headers);
}

// Lax, not Strict: the PWA share target opens /m/share from another app, a cross-site navigation that would
// drop a Strict cookie. Writes stay protected by the Origin check and the JSON content type.
function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

const CLEAR_COOKIE = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

// Only set Secure when behind a loopback HTTPS proxy (Tailscale Serve). On the LAN gateway port, both
// http:// and https:// are served on the same port, so omitting Secure lets a paired phone switch between them.
function cameOverHttps(req: IncomingMessage): boolean {
  return classifyPeer(peerOf(req)) === "loopback" && req.headers["x-forwarded-proto"] === "https";
}

function summarizeMobileRun(run: Run, position: number): MobileRunSummary {
  const outcome = endMessage(run, "gallery-dl");
  const step = run.steps[run.stepIndex]?.label;
  return {
    id: run.id,
    account: folderNameFor(run.spec),
    site: run.spec.site,
    ...(run.spec.postId ? { postId: run.spec.postId } : {}),
    media: run.spec.media,
    status: run.status,
    ...(step ? { step } : {}),
    stepIndex: run.stepIndex,
    steps: run.steps.length,
    counts: { ...run.counts },
    ...(run.progress ? { progress: { ...run.progress } } : {}),
    position: run.status === "queued" ? position : 0,
    remote: run.remote === true,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(outcome ? { errorMessage: outcome.text } : {}),
  };
}

function requireWriteAccess(req: IncomingMessage, res: ServerResponse): { ok: true; token: string } | { ok: false } {
  if (!isSameOriginPost(req.headers)) {
    json(res, 403, { ok: false, error: "That request didn't come from this page." });
    return { ok: false };
  }
  if (!isSameSiteJsonPost(req.headers)) {
    json(res, 400, { ok: false, error: "That request wasn't valid." });
    return { ok: false };
  }
  const token = readSessionCookie(req.headers.cookie);
  if (!authorizeSession(token, peerOf(req)) || !token) {
    json(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
    return { ok: false };
  }
  if (!canDeviceDownload(token)) {
    json(res, 403, { ok: false, error: DOWNLOAD_FORBIDDEN_MESSAGE });
    return { ok: false };
  }
  return { ok: true, token };
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

async function onDownloadsStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = readSessionCookie(req.headers.cookie);
  if (!authorizeSession(token, peerOf(req))) {
    return json(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
  }
  const canDownload = canDeviceDownload(token);
  await runQueue.whenReady();
  const live = new Map(runQueue.list().map((run) => [run.id, run]));
  const persisted = await listRuns(STATUS_RUN_LIMIT).catch(() => []);
  const byId = new Map<string, Run>();
  for (const run of persisted) byId.set(run.id, live.get(run.id) ?? run);
  for (const [id, run] of live) {
    if (!byId.has(id)) byId.set(id, run);
  }
  const runs = [...byId.values()]
    .sort((a, b) => compareRunIds(a.id, b.id))
    .slice(0, STATUS_RUN_LIMIT)
    .map((run) => summarizeMobileRun(run, runQueue.queuePosition(run.id)));

  json(
    res,
    200,
    { ok: true, canDownload, runs },
    {},
    (req.method ?? "GET").toUpperCase() === "HEAD",
  );
}

async function onDownloadStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireWriteAccess(req, res).ok) return;

  const raw = await readBody(req, MAX_DOWNLOAD_BODY_BYTES);
  if (raw === null) return json(res, 413, { ok: false, error: "That request was too large." });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { ok: false, error: "That request wasn't valid." });
  }

  const parsed = remoteDownloadRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(res, 400, { ok: false, error: parsed.error.issues[0]?.message ?? "That request wasn't valid." });
  }

  let specInput: unknown;
  try {
    const settings = await getSettings();
    if (parsed.data.mode === "run") {
      specInput = parsed.data.spec;
    } else if (parsed.data.mode === "account") {
      specInput = {
        ...createDefaultSpec(settings),
        site: parsed.data.site ?? "x",
        account: parsed.data.account,
        media: KIND_TO_MEDIA[parsed.data.kind],
        simulate: false,
      };
    } else if (parsed.data.mode === "link") {
      specInput = {
        ...createDefaultSpec(settings),
        site: "url",
        account: parsed.data.url,
        media: KIND_TO_MEDIA[parsed.data.kind],
        simulate: false,
      };
    } else {
      const post = parseXPostUrl(parsed.data.url);
      if (!post) {
        return json(res, 400, { ok: false, error: "Paste a valid X post link like https://x.com/username/status/123456." });
      }
      specInput = {
        site: "x",
        account: post.handle,
        postId: post.postId,
        media: "all",
        layout: { kind: "byType" },
        simulate: false,
        advanced: { ...DEFAULT_ADVANCED, cookies: { ...settings.cookies } },
      };
    }
  } catch (error) {
    console.error("grabberX: could not read settings for a remote download.", error);
    return json(res, 500, { ok: false, error: "The download couldn't be started." });
  }

  const validated = prepareRunSpec(specInput);
  if (!validated.ok) return json(res, 400, { ok: false, error: validated.error });

  try {
    const run = await runQueue.enqueue(validated.spec, { remote: true });
    const position = runQueue.queuePosition(run.id);
    return json(res, 200, { ok: true, runId: run.id, position, run: summarizeMobileRun(run, position) });
  } catch (error) {
    console.error("grabberX: could not queue a remote download.", error);
    return json(res, 500, { ok: false, error: "The download couldn't be started." });
  }
}

async function onDownloadHint(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? "/", "http://gateway.invalid").searchParams;
  const headOnly = (req.method ?? "GET").toUpperCase() === "HEAD";
  const parsed = accountHintInput.safeParse({
    site: query.get("site") ?? undefined,
    account: query.get("account") ?? "",
    folder: query.get("folder") || undefined,
  });
  if (!parsed.success) return json(res, 200, { ok: true, hint: { kind: "empty" } }, {}, headOnly);
  try {
    json(res, 200, { ok: true, hint: await getAccountHint(parsed.data) }, {}, headOnly);
  } catch (error) {
    console.error("grabberX: could not inspect the account for a phone.", error);
    json(res, 200, { ok: true, hint: { kind: "empty" } }, {}, headOnly);
  }
}

async function onDownloadStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireWriteAccess(req, res).ok) return;

  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw === null) return json(res, 413, { ok: false, error: "That request was too large." });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { ok: false, error: "That request wasn't valid." });
  }

  const parsed = remoteStopRequestSchema.safeParse(body);
  if (!parsed.success || !isValidRunId(parsed.data.runId)) {
    return json(res, 400, { ok: false, error: "That run doesn't exist." });
  }

  const runId = parsed.data.runId;
  await runQueue.whenReady();
  const run = runQueue.get(runId) ?? (await getRun(runId));
  if (!run) return json(res, 404, { ok: false, error: "That run doesn't exist." });
  if (run.remote !== true) {
    return json(res, 403, { ok: false, error: "Phones can only stop downloads started from a phone." });
  }

  try {
    const stopped = await runQueue.stop(runId);
    if (!stopped) return json(res, 409, { ok: false, error: "That run is no longer active." });
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error("grabberX: could not stop a remote download.", error);
    return json(res, 500, { ok: false, error: "The run couldn't be stopped." });
  }
}

async function onOfflineIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = readSessionCookie(req.headers.cookie);
  if (!authorizeSession(token, peerOf(req))) {
    return json(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
  }
  const parsedUrl = new URL(req.url ?? "/m/api/offline/index", "http://127.0.0.1");
  const since = parsedUrl.searchParams.get("since");
  const rawMatch = req.headers["if-none-match"];
  const ifNoneMatch = Array.isArray(rawMatch) ? rawMatch[0] : rawMatch;
  const headOnly = (req.method ?? "GET").toUpperCase() === "HEAD";

  try {
    const result = await buildOfflineIndex({ ifNoneMatch, since });
    if (result.notModified) {
      res.writeHead(304, {
        ...securityHeaders(),
        etag: result.etag,
        "cache-control": "no-cache",
      });
      res.end();
      return;
    }
    json(
      res,
      200,
      result.payload,
      { etag: result.etag, "cache-control": "no-cache" },
      headOnly,
    );
  } catch (error) {
    console.error("grabberX: could not build the offline library index.", error);
    json(res, 500, { ok: false, error: "The library index couldn't be read." });
  }
}

async function onOfflineThumb(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = readSessionCookie(req.headers.cookie);
  if (!authorizeSession(token, peerOf(req))) {
    return json(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
  }

  const parsedUrl = new URL(req.url ?? "/m/api/offline/thumb", "http://127.0.0.1");
  const account = parsedUrl.searchParams.get("account") ?? "";
  const relPath = parsedUrl.searchParams.get("path") ?? "";
  const versionParam = parsedUrl.searchParams.get("v");
  const headOnly = (req.method ?? "GET").toUpperCase() === "HEAD";

  const offlineSettings = await getOfflineSettings();
  if (!offlineSettings.enabled) {
    return json(res, 403, { ok: false, error: "Offline browsing is turned off on the PC." });
  }
  if (!account || !isAccountIncluded(offlineSettings, account)) {
    return json(res, 403, { ok: false, error: "That account isn't included in offline browsing." });
  }

  let file: Awaited<ReturnType<typeof statMediaFile>>;
  try {
    file = await statMediaFile(account, relPath);
  } catch (error) {
    if (error instanceof MediaPathError) return json(res, error.status, { ok: false, error: error.message });
    console.error("grabberX: could not read a file for an offline thumbnail.", error);
    return json(res, 500, { ok: false, error: "That file couldn't be read." });
  }

  const kind = mediaKindOf(file.name);
  if (!kind) return json(res, 400, { ok: false, error: "That isn't a media file." });
  if (!isKindIncluded(offlineSettings, kind)) {
    return json(res, 403, { ok: false, error: "That media type isn't included in offline browsing." });
  }

  const etag = etagOf(file.info);
  const versioned = versionParam === etag.replaceAll('"', "");
  const cacheHeaders = {
    etag,
    "cache-control": versioned ? "private, max-age=31536000, immutable" : "private, max-age=0, must-revalidate",
    "last-modified": file.info.mtime.toUTCString(),
  };

  const rawMatch = req.headers["if-none-match"];
  const ifNoneMatch = Array.isArray(rawMatch) ? rawMatch[0] : rawMatch;
  if (ifNoneMatch === etag) {
    res.writeHead(304, { ...securityHeaders(), ...cacheHeaders });
    res.end();
    return;
  }

  try {
    const outcome = await getOfflineThumbnail(file.full, kind, file.info, { failFastWhenPaused: true });
    if (outcome.status === "paused") {
      return json(
        res,
        503,
        { ok: false, paused: true, error: "Thumbnail generation is paused while a download is running." },
        { "retry-after": "5" },
      );
    }
    if (outcome.status === "unavailable") {
      return json(
        res,
        outcome.fallback === "canvas" ? 501 : 404,
        {
          ok: false,
          fallback: outcome.fallback,
          error: outcome.fallback === "canvas" ? "Thumbnails are unavailable on this PC." : "No video thumbnail available.",
        },
        { "x-offline-thumb-fallback": outcome.fallback },
      );
    }

    res.writeHead(200, {
      ...securityHeaders(),
      ...cacheHeaders,
      "content-type": "image/webp",
      "content-length": String(outcome.bytes.length),
    });
    if (headOnly) {
      res.end();
      return;
    }
    res.end(outcome.bytes);
  } catch (error) {
    console.error("grabberX: could not generate an offline thumbnail.", error);
    json(res, 500, { ok: false, error: "That thumbnail couldn't be built." });
  }
}

async function onOfflineFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = readSessionCookie(req.headers.cookie);
  if (!authorizeSession(token, peerOf(req))) {
    return json(res, 401, { ok: false, error: "Pair this phone from grabberX on the PC first." });
  }

  const parsedUrl = new URL(req.url ?? "/m/api/offline/file", "http://127.0.0.1");
  const account = parsedUrl.searchParams.get("account") ?? "";
  const relPath = parsedUrl.searchParams.get("path") ?? "";
  const versionParam = parsedUrl.searchParams.get("v");
  const headOnly = (req.method ?? "GET").toUpperCase() === "HEAD";

  const offlineSettings = await getOfflineSettings();
  if (!offlineSettings.enabled) {
    return json(res, 403, { ok: false, error: "Offline browsing is turned off on the PC." });
  }
  if (!account || !isAccountIncluded(offlineSettings, account)) {
    return json(res, 403, { ok: false, error: "That account isn't included in offline browsing." });
  }

  let file: Awaited<ReturnType<typeof statMediaFile>>;
  try {
    file = await statMediaFile(account, relPath);
  } catch (error) {
    if (error instanceof MediaPathError) return json(res, error.status, { ok: false, error: error.message });
    console.error("grabberX: could not read a file for an offline copy.", error);
    return json(res, 500, { ok: false, error: "That file couldn't be read." });
  }

  const kind = mediaKindOf(file.name);
  if (!kind) return json(res, 400, { ok: false, error: "That isn't a media file." });
  if (!isKindIncluded(offlineSettings, kind) || !isCopyEnabledForKind(offlineSettings, kind)) {
    return json(res, 403, { ok: false, error: "Offline copies are turned off for this media type." });
  }
  if (!(await isFileInOfflineSelection(account, relPath, offlineSettings))) {
    return json(res, 403, { ok: false, error: "That file isn't included in your offline selection." });
  }

  const fileV = etagOf(file.info).replaceAll('"', "");
  const preset = presetIdForKind(kind, offlineSettings);
  const etag = `"${fileV}-${preset}"`;
  const versioned = versionParam === fileV;
  const cacheHeaders = {
    etag,
    "cache-control": versioned ? "private, max-age=31536000, immutable" : "private, max-age=0, must-revalidate",
    "last-modified": file.info.mtime.toUTCString(),
  };

  try {
    const cached = await getCachedOfflineDerivative(account, relPath, fileV, kind, offlineSettings);
    if (!cached) {
      const pauseReason = await getOfflineDerivativeScheduler().getPauseReason(offlineSettings.onlyWhenPluggedIn);
      if (pauseReason === "download") {
        return json(
          res,
          503,
          { ok: false, paused: true, reason: "download", error: "Offline copy preparation is paused while a download is running." },
          { "retry-after": "5" },
          headOnly,
        );
      }
      if (pauseReason === "battery") {
        return json(
          res,
          503,
          { ok: false, paused: true, reason: "battery", error: "Offline copy preparation is paused while the PC is on battery." },
          { "retry-after": "30" },
          headOnly,
        );
      }

      if (kind === "video") {
        const encStatus = await getOfflineEncoderStatus(offlineSettings.video.encoder);
        if (!encStatus.codec) {
          return json(
            res,
            501,
            { ok: false, unavailable: true, error: encStatus.label },
            {},
            headOnly,
          );
        }
      }

      // Enqueue with priority ahead of background pre-generation and tell the phone to retry shortly.
      void enqueueOfflineDerivative(
        {
          account,
          relPath,
          fullPath: file.full,
          kind,
          size: file.info.size,
          mtimeMs: file.info.mtimeMs,
          v: fileV,
          settings: offlineSettings,
        },
        { priority: true },
      );

      const retryAfter = kind === "video" ? "5" : "1";
      return json(
        res,
        202,
        { ok: false, preparing: true, retryAfter: Number(retryAfter) },
        { "retry-after": retryAfter },
        headOnly,
      );
    }

    const rawMatch = req.headers["if-none-match"];
    const ifNoneMatch = Array.isArray(rawMatch) ? rawMatch[0] : rawMatch;
    if (ifNoneMatch === etag) {
      res.writeHead(304, { ...securityHeaders(), ...cacheHeaders });
      res.end();
      return;
    }

    const rawRange = req.headers.range;
    const rangeHeader = Array.isArray(rawRange) ? rawRange[0] ?? null : rawRange ?? null;
    const range = parseRange(rangeHeader, cached.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, {
        ...securityHeaders(),
        ...cacheHeaders,
        "content-range": `bytes */${cached.size}`,
      });
      res.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, cached.size - 1);
    const length = cached.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
      ...securityHeaders(),
      ...cacheHeaders,
      "content-type": cached.contentType,
      "accept-ranges": "bytes",
      "content-length": String(length),
      ...(range ? { "content-range": `bytes ${start}-${end}/${cached.size}` } : {}),
    });

    if (headOnly || cached.size === 0) {
      res.end();
      return;
    }

    const stream = createReadStream(cached.path, { start, end });
    res.on("close", () => stream.destroy());
    stream.on("error", () => {
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: "That offline copy couldn't be read." });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch (error) {
    console.error("grabberX: could not serve an offline copy.", error);
    json(res, 500, { ok: false, error: "That offline copy couldn't be built." });
  }
}

export function createMobileHooks(): GatewayHooks {
  return {
    authorize: (token, ip) => authorizeSession(token, ip),
    canDownload: (token) => canDeviceDownload(token),
    onPair: (req, res) => void onPair(req, res),
    onLogout: (req, res) => void onLogout(req, res),
    onDownloadsStatus: (req, res) => void onDownloadsStatus(req, res),
    onDownloadHint: (req, res) => void onDownloadHint(req, res),
    onDownloadStart: (req, res) => void onDownloadStart(req, res),
    onDownloadStop: (req, res) => void onDownloadStop(req, res),
    onOfflineIndex: (req, res) => void onOfflineIndex(req, res),
    onOfflineThumb: (req, res) => void onOfflineThumb(req, res),
    onOfflineFile: (req, res) => void onOfflineFile(req, res),
  };
}
