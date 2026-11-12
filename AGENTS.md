# AGENTS.md

Media-scraping workspace with a small Next.js app, **grabberX**, in the same root. Content is downloaded
X/Twitter media organized per account, using `gallery-dl` (directly in a terminal, or through grabberX).
Git versions the app (`src/`, `public/`, `docs/`, config files), `AGENTS.md`, `.agents/`, and
`skills-lock.json`. All media folders are git-ignored via `/*/` in `.gitignore` (the app folders are
re-included one by one), so never `git add -A` blindly and never assume account folders are tracked.

## The grabberX app

Local front end that builds the `gallery-dl` commands below from a form and runs them. Read
`docs/DESIGN.md` (screens, copy, states), `docs/ARCHITECTURE.md` (data model, ADRs) and
`docs/design-system/` (tokens and component specs) before changing it.

```powershell
npm run dev        # next dev -H 127.0.0.1 -p 3210
npm run build; npm start   # production, same host and port
npm test           # vitest: pure logic, runner (fake exe), queue, routes
npm run test:e2e   # playwright: real pages in Chromium against a dev server
npm run typecheck  # next typegen && tsc --noEmit
```

- Packaging (Windows installer): `npm run dist` builds `release\grabberX-Setup-<version>.exe`; `npm run pack` makes the
  unpacked app; `npm run test:e2e:packaged` drives the real Electron app (`GATHER_EXE` points it at a built
  `grabberX.exe`). Read `docs/PACKAGING.md` first. The shell is in `electron/` (own `package.json`, `npm ci
  --prefix electron`). In the packaged app every path comes from `GATHER_*` variables (`src/server/env.ts`) and a
  missing one is an error, never a `process.cwd()` fallback.
- E2E tests live in `e2e/` and drive the running app with Playwright (dev dependency). The config
  starts `npm run dev` itself and reuses an already-running server on `127.0.0.1:3210`. First run on a
  new machine needs `npx playwright install chromium` (browsers live outside the repo, in
  `%USERPROFILE%\AppData\Local\ms-playwright`). Traces and reports go to git-ignored folders.
- Playwright exists because a page can render correct HTML on the server and still crash in the
  browser: `e2e/pages.spec.ts` asserts no `pageerror` and no Next `global-error` fallback ("This page
  couldn't load") on Run, Library, History and Settings. Add a case there whenever a component starts
  or stops receiving a new prop shape, and use it to reproduce any report that `curl` cannot.

- It binds to `127.0.0.1:3210` only. `src/proxy.ts` rejects any other `Host`. With a `src/` folder,
  Next ignores a `proxy.ts` at the repo root, so keep it inside `src/`.
- `src/lib/` is pure and shared with the browser (`command.ts` builds argv, `parse-line.ts` reads
  output). `src/server/` is `server-only` (queue, runner, `.gather/` state). Run records live in
  `.gather/` (git-ignored); the app never opens an `archive.sqlite3` for writing.
- Cache Components is off on purpose (ADR-8). Every page that reads live state exports
  `dynamic = "force-dynamic"`, otherwise Next prerenders it at build time.
- A promise passed from a Server Component to a Client Component arrives as a Flight thenable whose
  `then()` returns `undefined` and which has no `.catch()`. Read it with `use()` or wrap it in
  `Promise.resolve()` before chaining; chaining directly crashes the page on hydration (the Library
  stats did exactly that).
- Relative timestamps must come from a `now` value the page passes down, not from `new Date()` inside
  a client component: server render and hydration land on different minutes and React reports a
  hydration mismatch. Library and History take `now={Date.now()}` and refresh it after mount.
- `buildCommand` output for the default settings must equal the commands under "Command shape"
  (`src/lib/command.test.ts` checks this). Change one, change the other.
- Stop runs `taskkill /T /F` on the gallery-dl process tree, then deletes `*.part` files; do not
  replace it with `child.kill()` (the PyInstaller bootloader would survive).
- Account folders and app folders share the root: `src`, `public`, `docs`, `node_modules`, and every
  dot-folder are reserved names (`src/server/paths.ts`).

## Mobile gallery (read-only, opt-in)

Settings → Mobile gallery shares the library with an Android phone on the same network (or Tailscale). Read
`docs/handoffs/mobile-gallery-link.md` and ADR-11 before changing it.

- A gateway (`src/server/mobile/gateway.ts`) is the only thing that listens on the network (`GATHER_MOBILE_PORT`,
  default 3211). The app on `127.0.0.1:3210` is unchanged. Do not add a route a phone should reach without adding
  it to the allowlist in `classifyRoute` and its test; do not import anything that writes files into `src/app/m/`
  or `src/components/mobile/`.
- Pairing is a single-use 5-minute token carried in the URL fragment; each phone then holds a hashed, revocable
  session cookie (`.gather/devices.json`, hashes only). Sharing state is `.gather/mobile.json`, off by default.
- Gateway and pairing state live on `globalThis` (`Symbol.for("gather.mobile.*")`) because `instrumentation.ts` and
  Server Actions can load separate module copies.
- Phones can read and download only: browse, sort and filter, multi-select, single-file download (`download=1`) and
  zip download (`POST /api/media/zip`, the one allowed POST besides pair/logout; it needs the session cookie and a
  matching `Origin`, and the request body is capped at 1 MB). Nothing that writes or deletes is in the allowlist.
- The gateway sends `Referrer-Policy: same-origin`, not `no-referrer`: Chrome sends `Origin: null` on a same-origin
  form POST under `no-referrer`, which the Origin check rightly rejects.
- The gateway does not proxy the dev server's hot-reload socket, so the phone pages only hydrate against a
  production build. `npm run build`, then `npm run test:e2e:mobile` (`playwright.mobile.config.ts`): it starts its own
  server on ports 3410/3411 with state and media folders under the temp directory, so it never touches the real
  `.gather` or library. The main Playwright config ignores `e2e/mobile.spec.ts`.
- Windows Firewall may block the port; Settings shows the `netsh` command that opens it on private networks.

## Environment (verified)

- `gallery-dl` = standalone exe `C:\tools\gallery-dl.exe`, v1.32.19 (bundled Python 3.14). `pip`/`python`
  on PATH is a *different* interpreter (3.11) without gallery-dl installed — do not try to `pip install` it.
- `yt-dlp` is **not installed** and is not needed: gallery-dl downloads X MP4s natively.
- `ffmpeg`/`ffprobe` 8.1.1 are on PATH (`C:\ProgramData\chocolatey\bin\`). From source the thumbnail warmer
  auto-detects `ffmpeg` on PATH to pre-build video posters; the packaged app uses only `GATHER_FFMPEG`, so it never
  runs an arbitrary PATH binary. It stays optional, and without it the browser captures posters as before.
- Auth is always `--cookies-from-browser firefox` (129 cookies, profile `a1b2c3d4.default-release-*`).
  Requires the user to be logged into x.com in Firefox; cookies are read fresh each run.
- Global config `%APPDATA%\gallery-dl\config.json` sets `base-directory: D:/Photos/p/scrapper/` and
  `extractor.twitter.directory: ["{user[name]}"]`. That default writes straight into `<name>/`, ignoring
  this repo's `Image`/`Video` convention — **always pass an explicit `-o directory=[...]`**.

## Layout convention

```
<account>/
  Image/            images (flat, or <YYYY>/ subfolders for a year-grouped account)
  Video/            videos (always flat)
  archive.sqlite3   gallery-dl download ledger, one per account
```

- A year-grouped account (e.g. `yearacct`) = `Image\{2024,2025,2026}\` + flat `Video\`.
- All other accounts = flat `Image\`, flat `Video\`.
- Filenames are `{tweet_id}_{n}.{ext}` — collision-free across any regrouping, so merging/renaming
  folders is safe and needs no de-duplication pass.

## Command shape

```powershell
# images
gallery-dl -o 'directory=["<acct>","Image"]' -o twitter.videos=false -o twitter.gifs=false `
  --filter "extension in ('jpg','jpeg','png','webp')" `
  --download-archive "<acct>/archive.sqlite3" --cookies-from-browser firefox "https://x.com/<acct>/media"

# videos
gallery-dl -o 'directory=["<acct>","Video"]' -o twitter.videos=true -o twitter.gifs=true `
  --filter "extension in ('mp4','webm','mov','m4v')" `
  --download-archive "<acct>/archive.sqlite3" --cookies-from-browser firefox "https://x.com/<acct>/media"
```

PowerShell quoting: `-o` takes JSON, so use single quotes outside and **double** quotes inside
(`'directory=["a","b"]'`). Single quotes inside the list make gallery-dl fail with
`Single '{' encountered in format string`.

## Gotchas that cost time

- **Archive is path-independent** (verified: moved files still report `#` skipped). Keys are source URLs.
  Never delete `<acct>/archive.sqlite3` — it is the only thing preventing full re-downloads.
- Images and videos share one archive per account; run the two passes **sequentially**, never concurrently,
  to avoid SQLite lock contention. The exception is grabberX's **parallel downloads** (ADR-10): workers of
  one step share the archive safely (gallery-dl opens it with a 60 s lock timeout and commits one row per
  file; audited and stress-tested), because each takes a disjoint `--range i::N` slice and its own
  `downloader.part-directory`. Never run parallel workers with a date-based folder layout.
- `--sleep` paces *file downloads*; `--sleep-request` paces the *API pagination calls*. Only the latter
  throttles rate limits. The user prefers **no `--sleep`**. gallery-dl auto-retries `429` (`-R`, default 4).
- Cookies do **not** exempt from rate limits — same internal GraphQL endpoints as the web client, higher quota only.
- Execution order per account: images first, then videos (video posts are skipped by the image filter, so
  neither pass interferes).
- Killing a run mid-file leaves `*.part` files (renamed only on completion). After any kill:
  `Get-ChildItem -Recurse -Force -Filter *.part | Remove-Item` before restarting, otherwise stale `.part`
  files linger and unrelated downloads resume cleanly but the debris stays.
- `-o directory=[...]` changes where files land but does **not** move existing ones — restructure with
  `Move-Item`, then rely on the archive so nothing re-downloads.
- Media is bulky (one account hit 3.14 GB / 103 videos). Never open, read, or diff binary media; report
  counts, byte totals, and dimensions instead (`System.Drawing` for images; Windows Shell COM
  `GetDetailsOf($item, 330)` / `328` for video width/height; ffprobe is on PATH too, but the app never depends on it).

## Verification commands

```powershell
gallery-dl --config-status                      # which config files are active
gallery-dl --simulate --range 1-2 ...           # what would download (prints `#`, no writes)
gallery-dl --range 1-2 ...                      # 2-file smoke test incl. folder layout
gallery-dl -K "https://x.com/<acct>/media"      # available metadata keys for --filter
```

Resolution sanity check for images (proof of `name=orig`, X caps at 4096 px):

```powershell
Add-Type -AssemblyName System.Drawing
Get-ChildItem "<acct>\Image" -File | ForEach-Object { $i=[System.Drawing.Image]::FromFile($_.FullName); "{0} {1}x{2}" -f $_.Name,$i.Width,$i.Height; $i.Dispose() }
```

## Skills

`gallery-dl` skill lives at `.agents/skills/gallery-dl/SKILL.md` and is symlinked into
`.claude/skills/gallery-dl`. `skills-lock.json` pins its upstream hash — edit the real file under
`.agents/`, not the link. Load it before adopting any gallery-dl workflow; its generic advice is a starting
point, the per-account conventions above override it.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
