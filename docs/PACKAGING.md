# Packaging gather as a Windows installer (Electron)

> **Status: implemented** on `feat/electron-packaging`. This file started as the handoff and still reads as
> the plan; the section below records how it was actually built and how to run it.

## As built

```powershell
npm ci; npm ci --prefix electron     # app dependencies, then the shell's own (electron-updater)
npm run dist                          # next build + standalone prep + gallery-dl seed + NSIS installer
npm run pack                          # same, unpacked into release\win-unpacked (faster, for testing)
npm run electron                      # run the shell from source against .next/standalone
npm run test:e2e:packaged             # drives the real Electron app; set GATHER_EXE to test a built Gather.exe
```

Output: `release\Gather-Setup-<version>.exe` (about 150 MB). Verified end to end: silent install into a temp
folder, the packaged suite against the installed app (welcome screen, setup, every page, Host check, a real
download through the bundled gallery-dl, clean quit), then uninstall, which removed the app and kept
`%APPDATA%\gather`.

Differences from the plan below:

- **Two `package.json` files.** `electron/package.json` is the installed app (shell plus `electron-updater`),
  so the installer does not also carry Next's dependencies. Keep its `version` equal to the root one;
  `electron/lib.test.ts` checks this.
- **Server files are plain files in `resources/server`**, not inside the asar. `electron-builder` never copies
  `node_modules` through `extraResources`, so `scripts/after-pack.cjs` does it. `scripts/prepare-standalone.mjs`
  deletes `.gather`, `src` and other folders the tracer can pull into the standalone output; `.gather` holds
  run history and must never be shipped.
- **Logging lives in the shell**, not the server: `main.cjs` pipes the server's stdout and stderr into
  `%APPDATA%\gather\logs\gather.log` (one rotated copy). Settings has an "Open the logs folder" button.
- **Versions:** the shell sets `GATHER_APP_VERSION`; Settings shows it under About. gallery-dl's version is
  the existing Check button.
- **Shutdown:** the server runs as an Electron `utilityProcess`; `main.cjs` posts `"shutdown"` and
  `src/server/shutdown-hook.ts` stops every run (taskkill, `.part` sweep) before exiting.
- **Closing the window** hides gather in the tray by default (`closeToTray` in `settings.json`, the
  "Desktop app" switch in Settings), so automatic runs and `electron-updater` keep working. With the switch
  off, closing quits (asking first while a run is active). The shell reads the setting at close time.
- **Shell bridge** (`preload.cjs`): `pickFolder`, `openLogs`, `trashItem`, `showItem`, `openItem`, `setTheme`.
  `trashItem`, `showItem` and `openItem` act only on a media file inside the library folder; `setTheme` keeps
  the window background in step with the page theme (saved in `userData/theme.txt` for the next start).
- **First run:** `/welcome` (library folder with a Browse button, cookie browser, gallery-dl check). Any page
  redirects there while `settings.json` does not exist and the app is packaged.
- **gallery-dl:** the standalone exe is published at `gdl-org/builds`, not the main repo. `scripts/fetch-gallery-dl.mjs`
  pins a tag and SHA-256 and refuses a mismatch. Settings has "Look for updates" / "Update now" (`gallery-dl
  --update-check` and `--update`), refused while a run is active.
- **Auto-update of the app** is on for CI builds and off for local ones. The workflow passes this repository as
  the publish target (`-c.publish.*`), so the build writes `app-update.yml` and `latest.yml`, and a `v*` tag
  uploads the installer, its blockmap and `latest.yml` to the GitHub release. The installed app checks on
  launch and every 6 hours and downloads in the background. A downloaded update installs itself silently when
  nobody is using gather (`autoInstallDecision` in `lib.cjs`): within 2 minutes of launch it restarts straight into
  the new version (the window shows "Updating gather to X…"); while the window is hidden in the tray it restarts
  back into the tray; while the window is open or a download runs it waits, shows one "ready, click to restart"
  notification, and looks again every 5 minutes. Install-on-quit stays on as a fallback, but it never fired in
  practice: gather sits in the tray, and a killed process or a Windows shutdown skips the quit event. A version
  that was already tried (recorded in `update-attempt.json`) is not retried for 6 hours, so a failing installer
  cannot restart gather in a loop. It can also be checked by hand from
  Settings → About or the tray menu ("Check for updates"); once downloaded, "Restart and update" stops the
  server's runs and runs the installer. The shell keeps one updater state (`nextUpdateState` in `lib.cjs`) and
  pushes it to the page over `gather:update-state`. Verified locally: a build with a publish target
  contains both files, and the app's check runs against GitHub and survives a 404. Not yet verified: a full
  update from one released version to the next, which needs two real releases.
- **Code signing** is optional and secret-driven. With `CSC_LINK` (a base64 `.pfx`) and `CSC_KEY_PASSWORD` set
  as repository secrets, electron-builder signs the installer and `Gather.exe`; without them the build is
  unsigned and SmartScreen warns on first run. Verified: empty values build fine and skip signing. Not
  verified: an actual signed build, because it needs a purchased code-signing certificate. A new
  certificate also starts with little SmartScreen reputation, so a warning can persist for a while.
- **CI:** `.github/workflows/build.yml` runs typecheck, unit tests, the page tests, builds the installer,
  smoke-tests the unpacked app, uploads the installer and, for a `v*` tag, creates a GitHub release. It has
  not run yet.
- **Not done:** a real signed build and a real release-to-release update (both need accounts outside this
  repo), and an automated test of the tray flow.

Handoff for whoever implements this. Goal: a user downloads `Gather-Setup-x.y.z.exe`, runs it, and gets a
Start-menu app that opens in its own window. No Node, no `npm`, no terminal. Windows 10/11 x64 only.
Everything stays on the user's machine.

Decision record: Electron + `electron-builder` (NSIS, per-user). Alternatives considered and rejected:
portable zip + Edge `--app` launcher (smaller, but updates and installer are hand-rolled) and Tauri +
Node sidecar (Rust glue, still ships Node). Add the outcome to `docs/ARCHITECTURE.md` as **ADR-9** and
amend ADR-7 ("Not deployable; local `next start`"), which this work changes.

## Target shape

```
%LOCALAPPDATA%\Programs\Gather\        installed app (replaced on update, never holds user data)
  Gather.exe                           Electron main process
  resources\app\                       Next standalone output (server.js, .next, node_modules subset)
%APPDATA%\gather\                      GATHER_HOME: settings.json, runs\, queue.lock, bin\gallery-dl.exe
<library folder, user-chosen>\         default %USERPROFILE%\Pictures\Gather
  <account>\Image, Video, archive.sqlite3
```

Process model: Electron main picks a free port, starts the Next standalone server as a child process
bound to `127.0.0.1`, waits until it answers, then loads `http://127.0.0.1:<port>` in a `BrowserWindow`.
The server still spawns `gallery-dl.exe` exactly as `src/server/runner.ts` does today.

## What already helps

- `GATHER_HOME` is already honoured (`src/server/store.ts`, `gatherHome()`), so app state can live in `%APPDATA%\gather`.
- Cookie browser is already a setting (`firefox | chrome | edge | none`) in the form and the schema.
- `galleryDlPath` and `mediaRoot` are already settings, only their defaults are developer-specific.
- `outputFileTracingExcludes` in `next.config.ts` already keeps media out of the traced output.

## Work items

Do them in this order; each one is shippable and testable on its own.

### 1. Make the app location-independent (no Electron yet)

| File | Change |
|---|---|
| `src/server/store.ts` `defaults()` | `galleryDlPath` default from `GATHER_GALLERY_DL` env, else `<GATHER_HOME>\bin\gallery-dl.exe`, else keep `C:\tools\gallery-dl.exe` for dev. `mediaRoot` default from `GATHER_MEDIA_ROOT` env, else `process.cwd()` for dev. |
| `src/server/hosts.ts` | Replace the hard-coded `3210` with a port read from `GATHER_PORT` (default `3210`). Keep it free of `server-only`: `src/proxy.ts` imports it. Confirm the env var is read at request time, not inlined at build. |
| `src/proxy.ts` | The 403 message names `127.0.0.1:3210`; build it from the same port value. |
| `src/server/paths.ts` | No change needed for a dedicated library folder (reserved names are harmless there). Keep `resolveAccountDir` as the only path gate. |

Update `src/lib/command.test.ts` only if the default command changes (it should not). Add unit tests for
the env-driven defaults and for `isAllowedHost` with a non-default port.

Also in this step (code changes that make the app safe to package):

- **One env module.** Create `src/server/env.ts` that reads and exposes port, `GATHER_HOME`, media root,
  gallery-dl path and an `isPackaged` flag. `store.ts` and `hosts.ts` import from it instead of reading
  `process.env` themselves. Keep it free of `server-only` because `src/proxy.ts` needs the port.
- **No silent `process.cwd()` fallbacks when packaged.** `defaults()` in `store.ts` uses
  `mediaRoot: process.cwd()` and `gatherHome()` falls back to `<cwd>\.gather`. Installed, `cwd` is the
  install directory, which the updater replaces. When `isPackaged` is true and `GATHER_MEDIA_ROOT` or
  `GATHER_HOME` is missing, throw a clear error. Keep the `cwd` defaults for dev only.
- **First-run signal.** Add `isConfigured()` in `store.ts` (true once `settings.json` exists) so the UI can
  send a new user to the setup screen (step 4) instead of guessing from folder contents.
- **Create the media root if missing.** The runner spawns with `cwd: settings.mediaRoot`
  (`run-queue.ts`); a deleted folder makes the spawn fail with a confusing error. `mkdir` it first.
- **Validate the library folder.** `listAccounts()` in `src/server/library.ts` already lists only folders
  that contain an `archive.sqlite3`, so picking `Documents` does not turn its subfolders into accounts.
  What is still missing is `assertSafeMediaRoot()` in `src/server/paths.ts`, called from `saveSettings`:
  reject a media root inside the install directory (`GATHER_APP_DIR`) or the state folder (`GATHER_HOME`).
  The function exists as a stub; the rule itself is the open decision.
- **Log to a file.** Server errors go to `console.error`, which is invisible in a packaged app. Write to
  `%APPDATA%\gather\logs\` (rotate or cap the size) so users can send it with a bug report.
- **Expose versions.** A server function returning the app version (from env, set by the shell) and the
  `gallery-dl --version` output, used by Settings, About and the update check.
- **Playwright base URL.** `playwright.config.ts` assumes `127.0.0.1:3210`; read a port env var so the
  same specs can run against the packaged build (step 7).

### 2. Standalone build

- Add `output: "standalone"` to `next.config.ts`. Read `node_modules/next/dist/docs/` first (see AGENTS.md:
  this Next version differs from what you know), including how `public/` and `.next/static` must be copied next to `server.js`.
- Script `npm run build:standalone`: `next build`, then copy `public` and `.next/static` into the standalone folder.
- The standalone `server.js` reads `PORT` and `HOSTNAME`; the launcher must pass `HOSTNAME=127.0.0.1`.
- Verify by running `node .next/standalone/server.js` with a clean `GATHER_HOME`, on a machine path with spaces.
- Check the "Cache Components off" and `force-dynamic` constraints (ADR-8) still hold in the standalone build.

### 3. Electron shell

New folder `electron/` (not under `src/`; it must not be bundled by Next). Add `electron` and
`electron-builder` as dev dependencies. Main process responsibilities:

1. `app.requestSingleInstanceLock()`; a second launch focuses the existing window.
2. Choose a free port (listen on port 0, read it, close, hand it to the server).
3. Start the server with Electron's bundled Node (`utilityProcess.fork` or `spawn(process.execPath, ["server.js"])` with `ELECTRON_RUN_AS_NODE=1`), so no separate `node.exe` ships.
   Check the Electron Node version satisfies Next's minimum engine.
4. Env for the server: `GATHER_HOME=%APPDATA%\gather`, `GATHER_PORT`, `GATHER_MEDIA_ROOT` (from saved choice), `GATHER_GALLERY_DL`, `HOSTNAME=127.0.0.1`.
5. Poll the port until it answers, then `loadURL`. Show a small splash/"Starting…" page meanwhile; on timeout show an error page with the log path.
6. Security: `contextIsolation: true`, `nodeIntegration: false`, no preload unless needed. Block navigation away from `http://127.0.0.1:<port>`; open external links with `shell.openExternal`. This keeps the `src/proxy.ts` Host check meaningful.
7. On quit: shut the server down gracefully. Windows has no SIGTERM, and `child.kill()` is a hard kill that
   leaves `*.part` files and an orphaned `gallery-dl.exe` (the same reason `runner.ts` uses
   `taskkill /T /F`). Start the server with `utilityProcess.fork` and send it a shutdown message; the server
   side handles it by running the existing Stop logic for every active run (`taskkill /T /F`, then delete
   `*.part`) and then exits. If you use `spawn` instead, expose a shutdown endpoint protected by the Host
   check, the Origin check and a per-launch random token. Give the server a few seconds, then force-kill it.
   Closing the window while a download runs should ask first, or minimise to tray.
8. Optional but recommended: tray icon so long downloads survive closing the window.

### 4. First-run setup

Shown inside the app (a Settings-like screen) when `settings.json` does not exist yet:

1. Choose library folder (folder picker via Electron `dialog.showOpenDialog`, exposed through a minimal preload and IPC; default `Pictures\Gather`, created if missing).
2. Verify `gallery-dl.exe` runs (`--version`); show the version.
3. Pick cookie browser; do a `--simulate --range 1-1` check against a public account and surface the result with the existing error kinds (`src/lib/error-kind.ts`). Chromium cookie reading can fail on recent Windows builds, so keep a clear "use a cookies.txt file" fallback in the copy.

### 5. gallery-dl as a separate, updatable component

X breaks scrapers often, so a frozen copy will rot. Ship the exe inside the installer as a seed, copy it on first run to `%APPDATA%\gather\bin\gallery-dl.exe`, and point `galleryDlPath` there.
Add "Check for updates" in Settings. Confirm with `gallery-dl --help` whether the standalone exe supports `--update`; otherwise download the latest release asset from the gallery-dl GitHub releases into `bin\` (write to a temp name, then rename). Show the version in Settings.
Licence: gallery-dl is GPL-2.0. Include its `LICENSE` in the installer and link to its source in an About screen.

### 6. Installer and updates

`electron-builder.yml`:

- `win` target `nsis`, `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: false` (installs to `%LOCALAPPDATA%\Programs`, no UAC).
- `extraResources`: the seed `gallery-dl.exe` and its licence; `asarUnpack` anything the server must read as real files.
- **Uninstaller must not delete the library folder or `%APPDATA%\gather`.** Set `deleteAppDataOnUninstall: false`. Test it with a populated library.
- `electron-updater` with GitHub Releases as the provider; check on launch, download in the background, apply on quit.
- Code signing: unsigned builds trigger SmartScreen. Fine for a first friends-and-family release, add a certificate before wider distribution. Document the "More info → Run anyway" step in the README.

### 7. Tests and CI

- Keep `npm test` and `npm run test:e2e` unchanged and green; they run against `next dev`.
- Add a packaged smoke test: install into a temp dir (or use the unpacked build), launch with a throwaway `GATHER_HOME`, assert the four pages load without `pageerror`, then quit and check no `gallery-dl` or `node` process remains.
- Use the existing `fake-gallery-dl.mjs` fixture to test a run end to end inside the packaged app without network.
- CI on `windows-latest`: `npm ci`, test, `build:standalone`, `electron-builder --win`, upload the installer as an artifact. Tag-triggered job publishes a GitHub Release.

## Deliberately left unchanged

- `explorer.exe` in `src/app/api/open-folder/route.ts` (Windows-only is in scope).
- `taskkill /T /F` in `runner.ts`; do not replace it with `child.kill()`.
- JSON state files and the pid-based `queue.lock` (a stale pid after a crash is already handled).
- The `src/lib` (pure) and `src/server` (server-only) split.

## Risks to check early

- **Next standalone file tracing** may miss files the server reads at runtime (anything via `fs`). Smoke-test every page and a real run.
- **Electron's Node vs Next's engine range.** If it does not match, fall back to shipping a pinned `node.exe`.
- **Antivirus false positives** on a freshly built, unsigned Electron app that spawns `taskkill` and `gallery-dl.exe`. Test on a clean Windows VM.
- **Port reuse race** between "pick free port" and the server binding it. Retry with a new port on `EADDRINUSE`.
- **Terms of service.** The app drives X with the user's own session. Keep it local-only, never log or transmit cookies, and include a short disclaimer on first run.

## Definition of done

A clean Windows 11 VM with no Node, Python or gallery-dl: install, complete first run, download one public account's images and videos, close and reopen (state kept), update gallery-dl from Settings, uninstall (library and `archive.sqlite3` files intact).
