# gather

A small desktop app that downloads media from social accounts into tidy per-account folders. It is a local
front end for [gallery-dl](https://github.com/mikf/gallery-dl): you fill in a form, gather builds the
`gallery-dl` command, runs it, and shows live progress. Everything runs on your own computer; nothing is
uploaded anywhere.

Windows 10 and 11 (64-bit) only for now.

## Install

1. Download `Gather-Setup-<version>.exe` from the [latest release](https://github.com/D9theCoder/grabberX/releases/latest).
2. Run it. It installs for your user only and does not ask for administrator rights.
3. The installer is not code-signed yet, so Windows SmartScreen may say "Windows protected your PC".
   Choose **More info**, then **Run anyway**.

On first launch gather asks where to keep your downloads (default: `Pictures\Gather`) and which browser you
are signed in to. gather reads that browser's cookies on every run to access accounts you can see; it never
copies or stores them. If a browser can't be read, switch to another one in **Settings**.

## Using it

- **Run**: pick a site, enter an account (or paste a profile link), choose images, videos or both, and start.
  Runs queue up, and Stop cancels cleanly.
- **Library**: every account you have downloaded, with sizes and an "update" button that fetches only what is
  new. Folders can be renamed or moved from here.
- **History**: past runs with their full logs.
- **Settings**: library folder, cookie browser, defaults, and gallery-dl updates.

Files are saved as `<account>\Image\` and `<account>\Video\`, with a small `archive.sqlite3` per account so
nothing is ever downloaded twice. Your settings and logs live in `%APPDATA%\gather`. Uninstalling never
deletes either your library or that folder.

## Updates

gather checks for a new version when it starts, downloads it in the background and installs it when you
quit. gallery-dl is updated separately from **Settings → Look for updates**, because sites change often and
its fixes shouldn't wait for an app release.

## Build from source

You need Node 22 and Windows.

```powershell
npm ci
npm run dev            # http://127.0.0.1:3210 in a browser; set your gallery-dl.exe path in Settings
npm test               # unit tests
npm run test:e2e       # page tests (run `npx playwright install chromium` once)
npm run typecheck
```

To build the installer:

```powershell
npm ci --prefix electron
npm run dist           # release\Gather-Setup-<version>.exe
npm run test:e2e:packaged
```

How it is packaged is written up in [docs/PACKAGING.md](docs/PACKAGING.md), and the design decisions are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Commit message rules are in [docs/COMMITS.md](docs/COMMITS.md). Every push to `main` is built by GitHub Actions, which bumps the patch version and publishes a release.

## Responsible use

gather is a convenience wrapper. You are responsible for following the terms of the sites you use it on and
for respecting the people whose content you download. It is not affiliated with any of those sites.

## License

[MIT](LICENSE). gather bundles an unmodified copy of gallery-dl, which is licensed under GPL-2.0; its license
text ships in the installer next to it.
