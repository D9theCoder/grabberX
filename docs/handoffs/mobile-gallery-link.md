# Handoff: mobile gallery link (read-only PWA over LAN / Tailscale)

Status: all phases built (gateway, pairing, device sessions, Settings UI, /m pages, PWA files, tests). Verified by unit tests and `e2e/mobile.spec.ts` against a production build on this PC. Not yet verified on a real Android phone. Date: 2026-11-12.
Goal: browse the gallery stored on the PC from an Android phone, without a native app.
Reference studied: `pingdotgg/t3code` (pairing and remote-access design, see "Lessons taken from t3code").

## 1. Requirements

Functional
- F1. Open a gallery on Android Chrome: account list, folder grid with thumbnails, swipe lightbox, video playback with seeking.
- F2. Pair a phone by scanning a QR code shown in desktop Settings. No typing, no accounts.
- F3. List paired phones in Settings; revoke one, or revoke all.
- F4. Installable to the home screen (PWA manifest). An offline cache is not required.

Non-functional
- N1. Read-only. A phone can never start, stop or change a run, change settings, delete files or open folders.
- N2. Off by default. The main app stays reachable on `127.0.0.1:3210` only (ADR-7 is not reversed for the desktop UI).
- N3. Only private networks: loopback, RFC1918, Tailscale (`100.64.0.0/10`). A public interface address never answers.
- N4. Library of 10k+ files per account stays fast: reuse thumbnails, ETag and `immutable` caching, Range streaming.
- N5. Works in the packaged Electron app (no `process.cwd()` fallbacks, paths from `GATHER_*`).

Constraints
- Windows PC, one user, Chrome on Android. Next.js 16 app with `server-only` code in `src/server/`.
- Plain HTTP on a LAN cannot register a service worker or show the install prompt; HTTPS needs Tailscale Serve.
  The page itself still works over HTTP and "Add to Home screen" creates a shortcut.

## 2. Decision: a gateway in front of the existing server

Do not open port 3210 and do not add routes that trust a header. Add a small `node:http` **gateway** that is the only
thing listening on the network, and that forwards a strict allowlist to the existing server on loopback.

```
 Android Chrome ──HTTP(S)──► gateway :3211 (0.0.0.0, only when enabled)
                              │ 1. peer IP must be loopback / private / tailnet
                              │ 2. method must be GET or HEAD (except /m/api/pair, /m/api/logout)
                              │ 3. path must match the allowlist
                              │ 4. cookie → hashed session lookup (except pairing + static assets)
                              ▼
                       Next server 127.0.0.1:3210  (unchanged, Host check still passes)
```

Why a gateway and not a second Next listener or guarded routes
- The security boundary is one small file (about 200 lines), testable without Next. The Next app gains no network exposure.
- A rejected request never reaches Next, so a bug in a page cannot leak the library.
- Streaming and Range work by piping the upstream response with its headers.
- Cost: one extra hop on localhost (negligible), and a proxy to maintain. Dev mode HMR sockets are not proxied;
  test the mobile surface against `npm run build; npm start`.

Allowlist (anything else answers 404, with no hint that the route exists)
| Path | Notes |
|---|---|
| `GET /m/**` | mobile pages (new) |
| `GET /api/media?...` | thumbnails and files; the existing route is GET-only |
| `GET /api/media/poster` | GET only; the POST that saves a poster stays blocked |
| `GET /_next/static/**` | JS and CSS |
| `GET /manifest.webmanifest`, `/m/sw.js`, icons | PWA |
| `POST /m/api/pair`, `POST /m/api/logout` | handled by the gateway itself, never forwarded |

Blocked on purpose: `/`, `/library`, `/history`, `/settings`, `/api/runs`, `/api/open-folder`, `/api/health`, every Server
Action POST, `/_next/image`, `/_next/data`.

The gateway forwards with `Host: 127.0.0.1:3210`, strips any inbound `x-gather-*` headers, and adds none.
The Next app needs no knowledge of the gateway.

## 3. Pairing and sessions

Lessons from t3code, adapted: one-time token, short TTL, atomic consume, secret in the URL fragment, per-device session,
hash at rest, secrets never listed back.

Flow
1. Desktop Settings → "Mobile access" → toggle on. Server picks the LAN IP (`os.networkInterfaces()`, first RFC1918 address,
   plus the Tailscale address when present) and starts the gateway.
2. "Pair a phone" calls a Server Action (loopback-only, because it lives on the desktop UI) that creates a token.
3. QR encodes `http://<ip>:3211/m/pair#<token>`. The token is in the fragment, so it is never sent in a request line,
   never in server logs, never in a `Referer`.
4. The `/m/pair` page reads `location.hash`, `POST`s it to `/m/api/pair`, then clears the hash with `history.replaceState`.
5. Gateway verifies, consumes, creates a session, answers `Set-Cookie`, the page redirects to `/m`.

Token
- 16 bytes from `crypto.randomBytes`, base32 (26 chars, 128 bits). No modulo bias because 256 divides by 32.
- TTL 5 minutes, single use. Stored hashed (SHA-256) in memory with `expiresAt` and `used`.
- Consume is one synchronous check-and-set; two scans cannot both win (single-threaded gateway).
- Wrong, expired and used tokens return the same generic 401 body.
- Rate limit: 5 failed pairs per IP per minute, then 429 for 10 minutes. Global cap of 30 failures per minute pauses pairing.

Session
- Cookie `gather_m=<32 random bytes, base64url>; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`; add `Secure` when
  the request arrived over HTTPS (Tailscale Serve sets `X-Forwarded-Proto: https`; trust it only from loopback).
- Stored as SHA-256 in `<GATHER_HOME>/devices.json` (the dev fallback home is `.gather/`): `{ id, tokenHash, label, userAgent, createdAt, lastSeenAt, lastIp }`.
  Write atomically (temp file and rename, as `store.ts` does for runs). `lastSeenAt` updates at most once a minute.
- Lookup is by SHA-256 of the cookie in a `Map`, so the secret is never compared directly and a guesser has nothing to time.
- Revoke deletes the row; the next request is 401. "Revoke all" empties the file. Turning mobile access off stops the listener
  and keeps the rows (so turning it on again restores phones) unless the user chooses "Turn off and forget phones".
- Cookie only; no bearer in URLs, no signed media URLs. `<img>` and `<video>` send the cookie automatically.

Settings UI (desktop)
- Toggle "Share gallery on my network", off by default, optional "turn off automatically after" (1 h / 8 h / never).
- Shows the reachable URL(s): LAN and Tailscale, with a warning on plain HTTP.
- Device list: label (default from the user-agent, editable), paired date, last seen, Revoke. Never shows the cookie or the token again.

## 4. Network exposure rules

- Bind `0.0.0.0` only while enabled. On each connection check `socket.remoteAddress` (normalize `::ffff:` IPv4-mapped):
  allow `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, IPv6 `::1` and `fe80::/10`; destroy the socket otherwise.
  This is not a firewall. A router that port-forwards looks private, so the token and cookie still decide access.
- Do not use the `Host` header for authorization (a LAN client can forge it, per t3code). Keep it only as the DNS-rebinding guard
  already in `src/server/hosts.ts`, widened for the gateway to the interface IPs and `*.ts.net` names it advertises.
- Windows Firewall: the first listen triggers the Windows prompt. Preferred: the installer or an elevated command adds
  `netsh advfirewall firewall add rule name="Gather mobile" dir=in action=allow protocol=TCP localport=3211 profile=private`.
  Settings shows this command when the phone cannot reach the PC. Public profile stays closed.
- Security headers on every gateway response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: private` (keep the upstream value for media), `Content-Security-Policy (default-src 'self', inline script and style allowed for Next hydration, frame-ancestors 'none')`.
- Path safety stays where it is: `parseRelativePath` / `resolveMediaPath` in `src/server/media.ts` reject traversal.
  The gateway allowlist is a second layer, not a replacement.
- HTTPS option: Tailscale Serve (`tailscale serve --https=443 http://127.0.0.1:3211`). Needed for the PWA install prompt and it
  encrypts the pairing exchange. Document it; do not implement certificate handling.

## 5. Mobile UI

New routes under `src/app/m/` (own layout, no desktop nav, no Server Actions):
- `/m` account list (reuse `listAccounts`), counts from `getAccountStats`.
- `/m/[account]/[...path]` folder view: `listFolder`, grid from `thumbnail.tsx` with the `?thumb=` sizes already supported.
- Lightbox with swipe, pinch zoom and native `<video controls>`; videos use the existing Range responses.
- Read-only variants: do not import `file-actions.ts` or the delete flow from `src/components/gallery/`. Check `gallery.tsx` and
  `lightbox.tsx`; if they import actions, extract a presentational layer first, or write small mobile components.
- Touch targets at least 44 px, no hover-only controls, `viewport-fit=cover`, safe-area padding.
- `/m` pages export `dynamic = "force-dynamic"` (ADR-8) and take `now` from the server (see the AGENTS.md hydration note).
- PWA: `manifest.webmanifest` (`display: standalone`, `start_url: /m`), icons 192 and 512, a minimal `sw.js` that caches only the
  shell; media is never cached by the service worker. Skip the service worker entirely over plain HTTP.

## 6. Module plan

| File | Role |
|---|---|
| `src/server/mobile/gateway.ts` | listener, peer filter, allowlist, proxy, security headers |
| `src/server/mobile/pairing.ts` | token create / consume, rate limit |
| `src/server/mobile/devices.ts` | `devices.json` read / write, hash, revoke |
| `src/server/mobile/network.ts` | interface scan, tailnet detection, advertised URLs |
| `src/server/mobile/*.test.ts` | pure logic: ip classification, token lifecycle, allowlist, session lookup |
| `src/instrumentation.ts` | `startMobileGateway()` beside the scheduler and thumb warmer; no-op when disabled |
| `src/server/store.ts` | `Settings.mobileAccess: { enabled, port, autoOffAt }`, default off |
| `src/app/settings/` | toggle, QR, device list (Server Actions, desktop only) |
| `src/app/m/**` | mobile pages |
| `e2e/mobile.spec.ts` | pairing and read-only checks |

Singleton caution: `instrumentation.ts`, route handlers and Server Actions can load separate copies of a module in Next.
Keep gateway state (pending tokens, listener handle) on `globalThis`, as the scheduler and run queue do, or the Settings action
will mint tokens the gateway cannot see. Verify this first with a small test.

Packaged app: Electron starts the server as a utility process with `HOSTNAME=127.0.0.1`; the gateway lives inside that process, so
no shell change is needed. Add `GATHER_MOBILE_PORT` (default 3211) to `src/server/env.ts`; in packaged mode a free-port fallback
must update the advertised URL.

## 7. Threat model

| Threat | Mitigation |
|---|---|
| Someone on the Wi-Fi scans the network | Off by default; every non-pair request needs a valid session cookie; allowlist answers 404 |
| Screenshot or shared QR | Token expires in 5 min and works once; the fragment keeps it out of logs |
| Token guessing | 128 bits plus per-IP and global rate limits |
| Stolen phone | Revoke in Settings; "Revoke all" |
| Cookie theft on plain HTTP | Documented; use Tailscale HTTPS off home Wi-Fi; SameSite=Strict, HttpOnly |
| Reaching desktop actions through the gateway | Method and path allowlist; Server Actions blocked; Next never sees non-allowlisted paths |
| Path traversal in media | Existing `resolveMediaPath` plus allowlist |
| DNS rebinding | Peer-IP filter, no `Host`-based auth, CSP `default-src 'self'` |
| Public exposure by port-forwarding | Peer-IP filter helps only partly; token and cookie are the real control; docs warn |
| Request flooding | Per-IP connection cap and header timeout on the `http.Server` |

## 8. Phases

1. ADR-11 in `docs/ARCHITECTURE.md` (partially supersedes ADR-7: the desktop UI stays loopback, a read-only gateway may listen on private networks).
2. Gateway, peer filter, allowlist and proxy with tests (no UI yet). Prove Range seeking through it with a real video.
3. Pairing and `devices.json`, with tests for expiry, single use, rate limit and revoke.
4. Settings UI: toggle, QR, device list. Add a case to `e2e/pages.spec.ts` for the new Settings props shape.
5. Mobile pages and lightbox. `e2e/mobile.spec.ts` at a 412x915 viewport: pair, browse, play, then assert that `/`, `/settings`
   and a Server Action POST all return 404 from the gateway.
6. PWA files, Tailscale HTTPS notes, firewall command, mobile section in `docs/DESIGN.md`.
7. Verify on a real Android phone: LAN pairing, video seek, revoke, toggling off.

## 9. Trade-offs and what to revisit

- PWA over a native app: reuses all gallery code and avoids APK signing; gives up background sync and bulk saving to the Android
  gallery. Revisit if offline use or widgets matter.
- Gateway over guarded routes: more code, but a smaller trusted surface. Revisit if Next adds a supported second network-facing server.
- Long-lived cookie (1 year): a phone should not re-pair weekly. Mitigated by revoke and a visible last-seen. Revisit with sliding
  expiry if the library becomes more sensitive.
- Cookie auth over DPoP / bearer: DPoP needs a native key store, unavailable to a plain web page. Acceptable on a private network
  for read-only media.
- No per-folder permissions: a paired phone sees the whole library. Revisit with per-device account allowlists.
- No mobile search or favorites in v1.

## 10. Open questions for the owner

1. Home Wi-Fi only, or also away from home through Tailscale? (decides how much HTTPS guidance to ship)
2. Should the phone see every account, or should Settings choose which accounts are shared?
3. Should a phone be allowed to download a file to its storage (a plain `Content-Disposition` link), or view only?
4. Who adds the firewall rule: the installer (needs elevation) or a command shown in Settings?

## 11. Lessons taken from t3code (source: `pingdotgg/t3code`)

- Pairing token: one-time, 5 min default TTL, atomic consume, rejection-sampled characters (`auth/PairingGrantStore.ts`).
- Secret in the URL fragment so it never reaches a server or log (`docs/internals/remote.md`, hosted pairing).
- The LAN listener closes connections unless both peer addresses are loopback, private or tailnet; explicitly "not a firewall".
- `Host` is forgeable on a LAN, so it is not an authorization check (`docs/internals/environment-auth.md`).
- The device list shows metadata only; the raw credential is returned once; revocation is per device.
- A token paired over HTTPS never travels over plain HTTP; Tailscale Serve is the recommended HTTPS route.
- Video responses omit cache validators so native seeks do not become full downloads. Gather's media route sends an ETag, so check
  that Range plus `If-Range` seeking behaves in Android Chrome before relying on it through the gateway.
- Not adopted: scoped RPC grants, DPoP, WebSocket tickets, OAuth. Not needed for a read-only gallery.

## 12. Build notes (added after implementation)

- Sharing state is `mobile.json` beside `devices.json`, not a field in `Settings`, so the settings schema and its page props did not change.
- The gateway runs inside the Next server process (`instrumentation.ts` calls `startMobileIfEnabled`). No Electron change was needed.
- The dev server is unsupported for the phone pages: the gateway does not proxy the HMR socket and hydration waits for it. Test with a production build.
- The CSP allows inline scripts and styles (Next hydration) and `unsafe-eval` only outside production.
- `/api/media/dims` is blocked by the gateway. `POST /api/media/zip` is allowed (session + same Origin + 1 MB body cap) so a phone can download a selection as a zip; `GET` on it stays blocked.
- When a video has no saved poster, its `/m` tile falls back to a muted, metadata-only `<video>` that shows the first
  frame. The phone never posts a poster, so the gateway's `POST /api/media/poster` stays blocked.
- The phone asks for the same 480 px thumbnails the warmer builds. It used to ask for 240 px, a size no warmer
  produced, so every mobile image was decoded on demand.
- The warmer also captures video posters when ffmpeg is available (`GATHER_FFMPEG`; from source it also searches
  PATH) and records each video's length; without ffmpeg the desktop browser still captures one, and the phone
  shows its metadata fallback.
- Phone read features: sort, filter (all / images / videos), multi-select (long press or Select), select all / none, single download, zip download (at most 5,000 files and 4 GB), a details panel (size, dimensions, date, link to the X post).
- The e2e test caught that `Referrer-Policy: no-referrer` makes Chrome send `Origin: null` on same-origin form POSTs; the gateway uses `same-origin`.
- The mobile e2e now has its own config and temp state (`npm run test:e2e:mobile`).
- Still open from section 10: owner answers (Tailscale use, per-account sharing, downloads, who adds the firewall rule). The build uses the defaults: all accounts shared, view only, a `netsh` command shown in Settings.
- Not done: real-phone test, installer step for the firewall rule, per-device account lists.
