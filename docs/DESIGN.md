# Design Handoff: grabberX

> **grabberX**: a local web front end for `gallery-dl`.
>
> **Design system (source of truth for tokens and components):** [`docs/design-system/project/`](design-system/project/) in git, mirrored to https://claude.ai/artifact/QqeuePNc22evgNcg2fzkjD
> It holds `tokens.json`, the brand book `README.md`, and one guideline + live preview per component. This file covers
> screens, behavior and edge cases; when it names a token or component, the design system defines it.
>
> **Sync rule:** always keep the two copies identical. The git copy is the source: commit a change there first, then publish it to the artifact. Never edit the artifact by hand, and never let the artifact overwrite the git copy.
> - Publish order: the content files first, then `project/design-system.json` last, with `lastChange` set to the time and the commit (`c962c35` style).
> - Stage the files from `git show HEAD:<path>` (LF) so the artifact matches the committed blobs, not CRLF working copies.
> - Check after publishing: read back `project/design-system.json` and one changed file, and confirm the sha256 matches the staged copy.

---

## 1. Design principles

1. **One screen does the job.** Pick a source, say what to keep, press Download. Everything else
   is folded away under *Advanced*, with defaults that are already right.
2. **Show the command.** The exact `gallery-dl` command is always visible and copyable, so every
   run can be reproduced in a terminal.
3. **Honest progress.** gallery-dl does not know the total file count up front, so there is no bar by default.
   Counters (saved, skipped, failed), the current file, elapsed time, speed and data downloaded are always shown. Where the site reports a count (X, whole-account runs: the profile's `media_count`), an estimated bar and ETA appear, worded "About 12% · ~N files", and never reach 100% until the run ends.
4. **Monochrome, words for status.** Ink and greys on `paper` (#FCFCFC). Selection is an ink fill
   or an ink radio, never a tinted fill with a colored border. Status is a word with a glyph, never a
   pill or an uppercase label. Color only means *failed* (`danger`) or *wait* (`warn`).
5. **Safe by default.** Defaults match the folder layout already in use
   (`<account>/Image`, `<account>/Video`, shared `archive.sqlite3`), so a run never re-downloads
   or scatters files.

## 2. Tokens (summary)

Full list with usage notes: the design system's `tokens.json`. All values are exposed as CSS custom
properties (`--paper`, `--ink`, `--space-4`, …) and mapped into Tailwind v4 with `@theme`.
Components reference tokens only, never raw hex or px.

| Group | Tokens |
|---|---|
| Grounds | `paper` #FCFCFC · `surface` #FFFFFF · `sunken` #F3F3F3 |
| Edges | `line` #E5E5E5 (dividers) · `line-strong` #C9C9C9 (containers) · `control` #8F8F8F (inputs, 3.2:1) |
| Text | `ink` #141414 (18:1) · `ink-2` #5C5C5C (6.5:1) · `ink-3` #8F8F8F (disabled only) · `on-ink` #FCFCFC |
| Meaning | `danger` #B3261E (6.4:1) · `warn` #8A5A00 (5.8:1) · `focus` = ink |
| Type | Schibsted Grotesk (`display` 28/34, `title` 17/24, `body` 15/22, `label` 14/20, `small` 13/18, `stat` 24/28) · Fragment Mono (`code` 13/20, `log` 12/18) |
| Space | 4 · 8 · 12 · 16 · 24 · 32 · 48 px |
| Radius | 4 · 6 · 8 px. Nothing pill-shaped. |
| Elevation | None. Borders only. |
| Motion | 120 ms hover/press, 200 ms disclosure and theme cross-fade, spinner only loops; all off under reduced motion |

**Dark theme.** Every color token has a dark value (design system `tokens.json`, theme `dark`): `paper` #121212 ·
`surface` #181818 · `sunken` #1F1F1F · `line` #2A2A2A · `line-strong` #3D3D3D · `control` #7A7A7A · `ink` #EDEDED ·
`ink-2` #A3A3A3 · `ink-3` #6B6B6B · `on-ink` #121212 · `danger` #F28B82 · `warn` #E0B04A. Components never name a
theme; `globals.css` swaps the variables under `:root[data-theme="dark"]`. An inline script in `<head>` sets
`data-theme` before the first paint from the saved choice (`localStorage` `gather-theme`) or the system setting.

`stage` (#0E0E0E light, #0A0A0A dark) is the ground behind the lightbox, always with `on-stage` (#FCFCFC) for its
text and controls. `on-ink` cannot serve there, because it turns dark in the dark theme.

## 3. Components

The design system ships 16 components with live previews: `Button`, `TextField`, `Segmented`,
`ChoiceList`, `Switch`, `Disclosure`, `CommandBlock`, `Status`, `Stat`, `LogView`, `Notice`, and the
gallery set `Breadcrumb`, `FolderCard`, `Thumbnail`, `Toolbar`, `Lightbox`.

In the Next.js app, build them as React components with the **same props** (`components/index.d.ts`
in the design system is the contract), styled with Tailwind from the tokens:

- Accessibility-heavy behavior comes from native elements first: `details/summary` for
  `Disclosure`, native radios for `ChoiceList`, `<input type="date">` for dates. `Segmented` is a
  `radiogroup` with arrow-key movement (a dozen lines). No date-picker or icon library.
- **No shadcn/ui.** Its default look (soft tints, pills, rings, shadows) is what this system avoids,
  and every component here is small enough to own outright.
- About ten inline SVG icons (24px grid, 1.75px stroke, round caps) live in
  `src/components/icons.tsx` with direct named exports.

---

## 4. Information architecture

```
/            Run          the form + live run panel (90% of use)
/library     Library      accounts already on disk: files, size, last run, "Update" button
/history     History      past runs, filterable by account and status
/history/[id]             one run: settings used, command, full log
/settings    Settings     gallery-dl path, media root, cookie browser + profile, defaults
```

Top bar: wordmark on the left, then `Run · Library · History`, with `Settings` as a gear on the right.
The current page shows an ink underline 2 px thick. No sidebar. In a browser, a quiet
`Get the desktop app` text link sits just before the gear and is hidden below 640 px.

---

## 5. Screen spec: Run (`/`)

### 5.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ grabberX          Run  Library  History                   (◌ 2)  ☾   ⚙       │  top bar 56px
├──────────────────────────────────────────────────────────────────────────────┤
│ New run                                                                      │  display
│ ┌─────────────────────────────────────────┐  ┌──────────────────────────────┐│
│ │ SOURCE                                  │  │ COMMAND                  copy ││
│ │ Site   [X ▾] [Instagram] [Bluesky] ...  │  │ gallery-dl -o 'directory=…'  ││
│ │ Account [@ username              ]      │  │   --filter "extension in …"  ││
│ │         ✓ On disk · 1,204 files · 3.1GB │  │   --download-archive …        ││
│ │                                         │  ├──────────────────────────────┤│
│ │ MEDIA   [ Images | Videos | All ]       │  │ [ Preview files ] [Download] ││
│ │                                         │  ├──────────────────────────────┤│
│ │ DATES   (All time)(30 days)(This year)  │  │ ● Running  username  02:14   ││
│ │         (Custom) [from] → [to]          │  │ 312 saved  1,090 skipped  0 ✕ ││
│ │                                         │  │ Video/1834…_1.mp4             ││
│ │ FOLDERS (•) By type   Image/ Video/     │  │ ┌ log ──────────────────────┐ ││
│ │         ( ) By type + year              │  │ │ …                         │ ││
│ │         ( ) Flat                        │  │ └───────────────────────────┘ ││
│ │         ( ) Custom                      │  │ [ Stop ]                     ││
│ │         preview: username/Image/…jpg    │  └──────────────────────────────┘│
│ │                                         │        (sticky, top: 24px)       │
│ │ ▸ Advanced  (3 changed)                 │                                  │
│ └─────────────────────────────────────────┘                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Container: `max-width: 1120px`, centered, side gutter `--space-8` (desktop) / `--space-4` (mobile).
- Grid: `grid-template-columns: minmax(0,1fr) 400px; gap: --space-8`.
- Right column is `position: sticky; top: --space-6`, so the command and the Download button never
  scroll away.
- **Compact.** The page fits a 1280 × 820 window without scrolling while Advanced is folded (an e2e
  test checks it). The title starts `--space-8` below the top bar. Each section is one row: its heading
  (`label`, 600) in an 88 px column, its controls beside it, `--space-4` above and below, a `line` rule
  between rows. Media and Dates carry their hint on the same line. Below 640 px, and between 1024 and
  1279 px (where the 400 px command panel leaves the form too narrow for the column), the heading sits
  above its controls.
- **Every segmented control is one row from 640 px up.** A ragged wrap, with one option alone on a second
  row, is a defect, not a fallback. If a set does not fit, shorten the labels, move qualifiers out of the
  options, or give the section more width; never let it wrap. Below 640 px a long set becomes an even grid
  (`columns`: Site 3, Folders 3, Dates 2), so every row has equal cells. `e2e/pages.spec.ts` checks every
  `Segmented` on Run and Settings at 640, 1024, 1280 and 1440 px.
- The command block scrolls inside itself past 176 px, so a long two-step command never pushes the run
  panel down.
- The page-title row is one fixed height on every page, so Library (with *Update all* beside its
  title) lands on the same baseline as Run, History and Settings.

### 5.2 Sections and fields

| # | Section | Control | Default | Notes |
|---|---|---|---|---|
| 1 | **Site** | `Segmented`: X, Instagram, Bluesky, Pixiv, Reddit, Other URL | X | Sites other than X are in beta until they pass a smoke test (see ARCHITECTURE §9). The `beta` tag sits on the Account field's label while such a site is picked, never inside the options (six tagged options do not fit one row). Each beta option's tooltip says "(beta)". Picking **Other URL** swaps the Account field for a full-URL field. |
| 2 | **Account** | `TextField` with a fixed `prefix` (`@` for X, `bsky.app/profile/` for Bluesky, and so on) | empty | Accepts a handle or a pasted profile URL. On paste, the URL is parsed and only the handle is kept. Below it, an **account hint** line (see 5.3). |
| 3 | **Media** | `Segmented`: Images · Videos · All | All | "All" runs images first, then videos, in one job. Each option has a tooltip listing the extensions it covers. |
| 4 | **Dates** | `Segmented` (sm): All time · Last 30 days · This year · Custom. "Custom" shows two native date inputs: *From* → *To* | All time | Both ends are optional. Hint text: "Uses the post date, not the download date." |
| 5 | **Folders** | `Segmented` (each option's tooltip shows the path it produces) plus the example path | By type | See 5.4. |
| 6 | **Advanced** | `Disclosure`, closed by default, `meta` reads "n changed" when n > 0 | closed | See 5.5. |

### 5.3 Account hint states

| State | Text (`small`) | Color |
|---|---|---|
| Empty | — (nothing shown) | — |
| Typing (debounced 300 ms) | — | — |
| Folder exists | `✓ On disk · 1,204 files · 3.1 GB · last run 3 days ago` | ink-2, with ✓ |
| New | `New account · will create new_account/` | ink-2 |
| Invalid | `X handles are 1–15 letters, numbers or _` | danger |
| Reserved name | `"src" is used by the app itself. Choose a different folder name in Advanced → Folder name.` | danger |
| Run already active | `A run for this account is in progress` (links to it) | warn |

### 5.4 Folder layouts

| Option | Writes to | gallery-dl `directory` |
|---|---|---|
| **By type** (default) | `<acct>/Image/…`, `<acct>/Video/…` | `["<acct>","Image"]` / `["<acct>","Video"]` |
| **By type + year** | `<acct>/Image/2025/…`, `<acct>/Video/…` | `["<acct>","Image","{date:%Y}"]` |
| **Year / month** | `<acct>/2025-03/…` | `["<acct>","{date:%Y-%m}"]` |
| **Flat** | `<acct>/…` | `["<acct>"]` |
| **Custom** | user template | text field, mono font, with a key picker (`{date:%Y}`, `{tweet_id}`, `{num}`, `{extension}`, `{author[name]}`) |

Under the list, show one **path preview** line in `code`, built from a sample post:
`username/Image/1834220145_1.jpg`. It updates on every change.

If the account folder already exists with a different layout (for example it has `Image/2024/`
but "By type" is selected), show a `Notice` (info):
*"Existing files use a different layout. They won't be moved. New files go to the new layout,
and nothing is downloaded twice."*

### 5.5 Advanced (folded)

Grouped into three blocks, each with a `title` heading in sentence case. Each control has a one-line hint.
A changed value shows "Changed · Reset" in `small` `ink-2` after its label; the `Disclosure` meta counts them.

**Quality**

| Control | Default | Maps to | Hint |
|---|---|---|---|
| Image size | **Original** | X: `-o twitter.size=["orig"]` (default already) | "Original is the full file the artist uploaded (X caps at 4096 px)." Options: Original, Large, Medium. Hidden for sites without size variants. |
| Min file size / Max file size | empty | `--filesize-min`, `--filesize-max` | "e.g. 200k, 5M" |
| Include retweets | off | `-o twitter.retweets=false` | X only |
| Include replies | **on** (gallery-dl default, matches AGENTS.md) | `-o twitter.replies=false` only when turned off | X only |

**Pace and limits**

| Control | Default | Maps to | Hint |
|---|---|---|---|
| Wait between pages | 0 s | `--sleep-request` | "Slows page loading. The only setting that helps against rate limits." |
| Wait between files | 0 s | `--sleep` | "Slows downloads, not page loading." |
| Wait after rate limit (429) | gallery-dl default | `--sleep-429` | |
| Retries | 4 | `-R` | |
| Bandwidth cap | none | `--limit-rate` | "e.g. 2M" |
| Stop when caught up | **on** for accounts already on disk, off for new | `-A 20` | "Stops after 20 files in a row are already saved. Makes updates fast." |
| Only the newest N files | empty | `--range 1-N` | Useful for a quick test |
| Parallel downloads | 1 | N workers, each `--range i::N` (or `i:limit+1:N`) and its own `downloader.part-directory` | `Segmented` (sm) 1 · 2 · 3 · 4. Enabled only for sites that do not limit requests (Bluesky, Other URL) with the By type or Flat layout; otherwise 2–4 are disabled and the hint gives the reason ("X limits requests, so it downloads one file at a time." / "Parallel downloads need the By type or Flat layout."). When active, a line under the command says "Runs as N processes at once…". History shows "Parallel downloads: N at once". |

**Output and session**

| Control | Default | Maps to |
|---|---|---|
| Save metadata (.json beside each file) | off | `--write-metadata` |
| Overwrite existing files | off | `--no-skip` (shows a danger hint) |
| Cookies from | Firefox (from Settings) | `--cookies-from-browser firefox[:profile]` |
| Folder name | account handle | overrides `<acct>`, needed for reserved names |
| Proxy | empty | `--proxy` |

### 5.6 Command panel (right column)

- **`CommandBlock`:** `sunken` body, `line-strong` edge, `radius-lg`, `code` text. One flag per line, each
  ending in a backtick (PowerShell's line continuation). Values in `ink`, flags in `ink-2`. Copy sits
  top-right and reads "Copied" with a check for 1.5 s, announced politely.
- When Media is **All**, the block shows two tabs, `1 · images` and `2 · videos`.
- Long values wrap inside the block, so no flag is ever cut off; each flag still starts its own line and
  keeps its trailing backtick. Copy always copies the unwrapped command.
- **Actions:** `Preview files` (`secondary`: runs `--simulate`, lists what would download without
  writing anything) and `Download` (`primary`, ink fill). Both are full-width in a 2-column row.
- **Disabled reasons** show as a hint under the buttons, never as a silent disabled button:
  "Enter an account first", "gallery-dl not found, check Settings".

### 5.7 Run panel (replaces the empty state under the actions)

| Part | Spec |
|---|---|
| Header | `Status` with account and elapsed `mm:ss` as its detail: "Running · username · 02:14" |
| Counters | Three `Stat`s: **saved** (default), **skipped** (`muted`), **failed** (`danger` when > 0). |
| Current file | One mono line, truncated in the middle (`Video/18342…_1.mp4`), full path in `title`. |
| Speed and ETA | `RunProgress` (src/lib/progress.ts): speed over a 15 s window, bytes from the saved files, all workers and the whole run combined. Bar and "about N min left" only when `total` is known (X, media "All", no date or range limits; one `gallery-dl -j --range 1` probe reads `media_count`). After the run: "avg speed · size downloaded". The task bubble shows `~%` and speed per run. |
| Phase | For "All": `Step 1 of 2 · images`. |
| Rate-limit wait | `Notice` (warning): "Rate limited · retrying in 0:42 (2 of 4)", counting down. |
| Log | `LogView`, collapsed to the last 6 lines and expandable to 320 px max height, scrolling. `#` skipped lines are `ink-2`, warnings `warn`, errors `danger`. Auto-scrolls only while the user is at the bottom. |
| Actions | `Stop` (`danger` button). After the run ends: `Open folder` and `Run again`. |

Empty state (no run yet): one line in `ink-2`, "Runs appear here. Nothing is downloaded until you
press Download."

### 5.8 Component states

Hover, focus, selected, disabled and loading states for every component are defined in the design
system (brand book → States, and each component's guideline). Screen-specific rules:

- Download is never silently disabled: the reason sits under it in `small`. A disabled Download keeps a
  15% ink fill and an ink label (about 13:1), so it still reads as the primary action instead of
  disappearing into the page.
- While a run is active for the chosen account, Download reads `Queue`.
- Focus is always the 2px `focus` outline with a 2px offset.

### 5.9 Responsive

| Breakpoint | Changes |
|---|---|
| ≥ 1024 px | Two columns, as above |
| 640–1023 px | One column. The command panel moves under the form. A **sticky bottom bar** (`paper`, `line` top border) holds `Preview files` + `Download`, plus the run status when one is active. Tapping it scrolls to the run panel. |
| < 640 px | Long `Segmented` sets become even grids (Site and Folders in 3 columns, Dates in 2). Date inputs stack. Command preview is folded behind a "Show command" link. 16 px gutter. No horizontal page scroll. |

Touch targets are at least 40 × 40 px everywhere, and the segmented controls reach 44 px tall on phones.
One control height (`--spacing-control`) applies to every control, whatever its size.

### 5.10 Edge cases and copy

| Situation | What the user sees |
|---|---|
| gallery-dl missing / wrong path | `Notice` (danger) under the top bar: "gallery-dl wasn't found at C:\tools\gallery-dl.exe. **Set the path**". Download is disabled. |
| Browser cookies cannot be read | `Notice` (warning) above the run buttons: "grabberX can't read Firefox's cookies. Close Firefox, or pick another browser in Settings." with **Open Settings**. The run still starts. |
| Cookies look signed out | `Notice` (warning): "Firefox cookies for x.com look signed out. Sign in to x.com in Firefox, then try again." The run still starts, since public accounts need no login. |
| Firefox not logged in to the site / cookies expired | Run fails with: "X asked for a login. Open x.com in Firefox, sign in, then run again." |
| Account doesn't exist or is protected | "This account doesn't exist or its posts are protected." |
| Rate limited, retries exhausted | "X is limiting requests. Wait about 15 minutes, or set *Wait between pages* to 2 s." |
| Date *From* is after *To* | Inline error under the dates: "Start date is after end date." |
| Disk full | "The drive is full. 312 files were saved before it stopped." |
| Stop pressed | Status reads "Stopping", then "Stopped". Partial `.part` files are cleaned up and the copy says so: "Stopped. Unfinished files were removed." |
| Second run for the same account | Download label changes to `Queue`. Status reads "Queued · 1 ahead" in `warn` text below the buttons. |
| 0 new files | Done state reads "Up to date · nothing new since last run." |
| Very long handle / custom template | Inputs never grow. Preview line truncates in the middle with an ellipsis. |

### 5.11 Accessibility

- Focus order: Site → Account → Media → Dates → Folders → Advanced toggle → (Advanced fields) →
  Copy → Preview files → Download → Stop.
- Every control has a visible `<label>`. `Segmented` is a `radiogroup` with arrow keys.
- `Ctrl+Enter` anywhere in the form = Download (shown as a hint in the button tooltip).
- Run status is announced through one `aria-live="polite"` region, **throttled**: start, every
  phase change, rate-limit waits, and the end. Never per file.
- Each `Stat` is one labelled group: "312 saved".
- Color is never the only signal: failed shows ✕ and the word; a selected segment is an ink fill, not a hue.

---

## 6. Library (`/library`)

A table, not cards. Columns: **Account** (mono) · Images · Videos · Size · Last run · Layout · actions.

- Sort by last run (default), name, or size. A search box filters as you type.
- Row actions: `Update` (starts a run with the account's saved settings and "Stop when caught up"
  on, but only when the account's last real run finished `done` without a range; after a failed or
  stopped run it walks the whole account so the backlog is not skipped), `Open folder`, and an
  overflow menu with `Move` (inline rename form; refuses while a run is queued or running for
  either name, and when the target exists — files and the archive never re-download after a move)
  and "Use as new run" (fills the form).
- Accounts are detected as top-level folders that contain `archive.sqlite3`, so app folders
  (`src`, `public`, `node_modules`…) never appear.
- Empty state: "No accounts yet. Your first download will show up here." followed by a **Start a
  download** link to Run. `Update all` stays disabled until there is an account.
- `Update all` button top-right runs every account one after another (queued).
- Below 768 px the table becomes a stacked list: account, the three counters, last run, layout, and
  an overflow menu with the row actions.

### 6.1 Account gallery (`/library/[account]`)

Opened from the account name in the Library table. Media is the focus: no tiles with captions, no chrome
beyond a breadcrumb, a filter and a sort.

- **Route.** `/library/[account]?path=Image/2025` shows one folder. The query string keeps the URL
  shareable and Back working. `?file=<name>` opens the lightbox on that file, so a reload keeps the place.
- **Header.** Breadcrumb `Library / account / Image / 2025`, then the folder name as the page title (mono).
- **Browse.** Sub-folders first as `FolderCard`s (Image, Video, year folders), then the files as justified
  rows that keep each file's aspect ratio. Only the rows near the viewport are rendered, so a folder of
  thousands of files stays responsive.
- **Thumbnails.** Every tile loads a 480 px WebP from `/api/media?...&thumb=480&v=<version>`. The version is the
  file's size and modified time, so the URL is cached by the browser for good and a revisited folder paints
  from its cache. Thumbnails are built ahead of time by a background warmer (after each download, and once
  shortly after start) and kept under the state folder (`thumbs/`, capped at 1 GB). Videos show a poster frame
  that the warmer captures with ffmpeg when available, or one the browser captured the first time the tile
  loaded the video's metadata; either way the tile also shows a play glyph and the length. The same ffmpeg pass
  records each video's length in the media index. If thumbnails are unavailable (`sharp` failed to load) the
  browser scales the original.
- **Layout without waiting.** Image sizes and video lengths come from a per-folder index on disk
  (`index/`), read with the page, so the justified rows are right on the first paint. Files the index does
  not know yet are filled in by `/api/media/dims`, which reads only image headers.
- **Select mode.** The Select button beside Sort (also `S`, Ctrl+A, Space on a tile, Ctrl/Shift+click, or the
  context menu) turns tiles into toggles with a check box. Click toggles, Shift+click selects a range, and
  pressing the mouse and dragging draws a rectangle that selects every tile it touches, scrolling the page when
  the pointer nears the top or bottom edge. A drag that starts on a selected tile deselects instead. The
  `SelectionBar` sticks to the bottom: count, Select all, Clear, Download, Delete, Done. Esc leaves select mode.
- **Download.** One file downloads as itself. Several stream from `/api/media/zip` as one stored zip (no
  re-compression; at most 4 GB and 65,535 files).
- **Right-click.** The app's `ContextMenu` replaces the browser menu everywhere except text fields. On a tile:
  Open, Open with default app (desktop) or Open in new tab (browser), Show in folder (desktop; the browser
  opens the account folder), Download, Copy image, Copy path, Select, Delete. On a selected tile with others
  selected: Download n files, Copy n paths, Clear selection, Delete n files. On the grid: Select all, Select
  files, Download all, Open account folder. In the lightbox: the tile items plus Delete. Elsewhere: Copy
  (when text is selected), Back, Forward, Reload.
- **Filter and sort.** Show: All, Images, Videos. Sort: Newest first, Oldest first, Name. File names are
  `{post_id}_{n}.{ext}`, so name and post order agree.
- **Keyboard.** One tile takes Tab. Arrow keys move between tiles (up and down keep the column), Home and End
  jump, Enter opens the lightbox. Esc in the lightbox returns focus to the tile.
- **Empty folder.** "No files here yet." with a link back to the account. A filter with no match says
  "Nothing matches this filter in this folder."
- **Lightbox.** `stage` ground. Fit to screen; scroll or pinch to zoom, double-click for 100 percent, drag to
  pan. Left and right arrows move, Esc closes, `F` fullscreen, `I` details, Space plays a video. Counter
  "3 of 128". Details: file, dimensions, size, post date, link to the post. Actions: Open in Explorer (opens the
  account folder), Copy path, Delete.
- **Delete.** Asks first: "It moves to the Recycle Bin. grabberX still remembers it in the archive, so a later
  update will not download it again." For a selection the dialog names the count. In the packaged app the files
  go to the Recycle Bin; from source they are deleted for good and the dialog says so. The archive is never
  touched.
- **Safety.** Every path is resolved inside the account folder. `..`, absolute paths, reserved folders, other
  accounts, symlinks that leave the folder and non-media extensions are refused.

## 7. History (`/history`, `/history/[id]`)

- List: `Status`, account, media, started, duration, saved/skipped/failed.
- Below 768 px each run becomes a stacked line with the same fields, since the eight columns cannot fit.
- Detail: the settings used (read-only summary), the exact commands, full log (with
  `content-visibility: auto` for long logs), and `Run again`.

## 8. Settings (`/settings`)

Plain form, saved on blur with a quiet "Saved" tick, in this order:
gallery-dl path (with a `Check` button that runs `--version`, `Look for updates` and the installed
version beside it) · Media root (default: the app folder) · Session (Cookie browser, profile, and a
`Check cookies` button) · Defaults for new runs · Runs · Automatic updates · Appearance (Theme: System,
Light, Dark) · Desktop app (desktop only) · About (last).

**Desktop app → "Keep grabberX in the tray when the window closes"** (`closeToTray`, on by default). On: closing
hides the window, a one-time balloon says grabberX is still in the tray, and scheduled runs and app updates keep
working; Quit lives in the tray menu. Off: closing quits, after the usual "downloads are still running"
question when a run is active.

**Top bar.** A `ThemeToggle` sits just left of the Settings gear: the moon in light, the sun in dark, labelled
"Switch to dark mode" / "Switch to light mode". The switch cross-fades the page in 200 ms.

**Task bubble.** While any run is running or queued, a pill left of the theme switch shows how many (a spinner
while one runs, a clock while all wait), labelled "Tasks: 1 running, 2 queued". It disappears when the queue is
empty. Clicking it opens a panel listing running runs first, then the queue in start order: the folder, its
status and detail ("Videos 2/2 · 1,284 saved" or "#1 in line"), and Stop (running) or Cancel (queued). A row
opens that run in History; the footer opens History. Esc or a click outside closes it. The bubble polls
`/api/runs` every 2 s while something runs and every 5 s otherwise, not at all in a hidden tab, and refreshes at
once when this page starts a run.

**About → Check for updates** (desktop only). Shows the updater's state under the button: "Checking for
updates…", "grabberX is up to date. Checked 2 minutes ago.", "Downloading grabberX 0.2.0 · 42%", or "Couldn't
check for updates: …". Once an update is downloaded the button becomes "Restart and update" (asks first while
downloads run). The tray menu has the same item. Settings is deliberately
narrow (max 672 px): it is read one field at a time, while Run, Library and History use the full
1120 px container.

`Check cookies` probes x.com with the selected browser, since Settings has no account to check. It
shows the same two warnings as the Run screen, and reads nothing when the browser is **None**.

---

## 9. Copy voice

Short, plain, second person, no exclamation marks. Verbs on buttons: **Download**, **Preview files**,
**Stop**, **Update**, **Run again**, **Open folder**. Don't say "scrape", "job", or "extractor"
in the UI. Say **run**, **account**, **files**.
