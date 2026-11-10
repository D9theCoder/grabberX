# AGENTS.md

Media-scraping workspace, **not a code repo**. No build, tests, or lint. Content is downloaded
X/Twitter media organized per account. The only tool is `gallery-dl`. Git is initialized solely to
version `AGENTS.md`, `.agents/`, and `skills-lock.json` — all media folders are git-ignored via
`/*/` in `.gitignore`, so never `git add -A` media or assume account folders are tracked.

## Environment (verified)

- `gallery-dl` = standalone exe `C:\tools\gallery-dl.exe`, v1.32.19 (bundled Python 3.14). `pip`/`python`
  on PATH is a *different* interpreter (3.11) without gallery-dl installed — do not try to `pip install` it.
- `yt-dlp` is **not installed** and is not needed: gallery-dl downloads X MP4s natively.
- Auth is always `--cookies-from-browser firefox` (129 cookies, profile `a1b2c3d4.default-release-*`).
  Requires the user to be logged into x.com in Firefox; cookies are read fresh each run.
- Global config `%APPDATA%\gallery-dl\config.json` sets `base-directory: D:/Photos/p/scrapper/` and
  `extractor.twitter.directory: ["{user[name]}"]`. That default writes straight into `<name>/`, ignoring
  this repo's `Image`/`Video` convention — **always pass an explicit `-o directory=[...]`**.

## Layout convention

```
<account>/
  Image/            images (flat, or <YYYY>/ subfolders for yearacct)
  Video/            videos (always flat)
  archive.sqlite3   gallery-dl download ledger, one per account
```

- `yearacct` = `Image\{2024,2025,2026}\` + flat `Video\`.
- All `acct_*` and newer accounts = flat `Image\`, flat `Video\`.
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
  to avoid SQLite lock contention.
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
  `GetDetailsOf($item, 330)` / `328` for video width/height, since ffprobe is not installed).

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
