# Architecture Handoff: gather

A local Next.js app that builds `gallery-dl` commands from a form, runs them as child processes on
this PC, and streams progress back to the browser.

Verified against the running system on 2026-11-11: gallery-dl **1.32.19** at
`C:\tools\gallery-dl.exe`, Node **22.17.0**, npm **11.6.4**, Next.js docs for **16.4**.

---

## 1. Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | Pick a site (X first; Instagram, Bluesky, Pixiv, Reddit and "any URL" behind a beta flag) |
| F2 | Enter an account (handle or pasted profile URL) |
| F3 | Choose media: images, videos, or all |
| F4 | Optional date range (post date) |
| F5 | Choose a folder layout (presets or a custom template) |
| F6 | Advanced settings: image size (original by default), sleeps, retries, rate cap, file-size limits, stop-when-caught-up, range, metadata, overwrite, cookies, proxy |
| F7 | See and copy the exact command before running |
| F8 | Dry run ("Preview files", `--simulate`) |
| F9 | Live progress: saved / skipped / failed counts, current file, log, rate-limit waits |
| F10 | Stop a run cleanly (no orphan processes, no `.part` debris) |
| F11 | Queue runs; one run per account at a time |
| F12 | Library of accounts on disk, with one-click Update and Update all |
| F13 | History of runs with settings, command, and log |

### Non-functional

| Concern | Target |
|---|---|
| Users | One person, one PC. No accounts, no login. |
| Network exposure | `127.0.0.1` only. Never reachable from the LAN. |
| Scale | Tens of accounts, runs of up to tens of thousands of files and several GB. |
| Correctness | Never re-download (shared `archive.sqlite3` per account). Never two writers on one archive. |
| Footprint | No database server, no Redis, no Docker. One `npm run start`. |
| Resilience | An app restart must not corrupt the archive. Runs that were in progress are marked `interrupted`. |

### Constraints

- **The repo sits in the workspace root** (`D:\Photos\p\scrapper`), next to the account folders.
  No `web/` subfolder. (User requirement.)
- **Cannot run on Vercel or any host.** It spawns a local `.exe` and writes to `D:\`. This rules out
  serverless, Edge runtime, and the `vercel-optimize` workflow (which needs a deployed project's
  metrics). The Vercel React rules still apply to the code itself.
- gallery-dl is a **standalone PyInstaller exe**, not a Python package. It cannot be imported. It is
  only usable through its CLI.

---

## 2. High-level design

```
 Browser (localhost:3210)                         Node process: `next start -H 127.0.0.1`
┌───────────────────────────┐        ┌──────────────────────────────────────────────────────────┐
│ RSC page  /               │  HTML  │  app/page.tsx (Server Component)                         │
│  ├ <RunForm/> (client)    │◄───────┤   reads settings + library summary (fs) in parallel      │
│  │   builds JobSpec       │        │                                                          │
│  │   shows CommandPreview │        │  Server Actions (actions.ts)                             │
│  │   (same pure builder)  │ action │   startRun(spec) ─► zod validate ─► RunQueue.enqueue()   │
│  ├ <RunPanel/> (client)   ├───────►│   stopRun(id)    ─► RunQueue.stop()                      │
│  │   EventSource ─────────┼──┐     │                                                          │
└──────────────────────────┘  │     │  Route Handler  GET /api/runs/[id]/events  (SSE)          │
                               └────►│   subscribes to RunQueue events, replays buffered lines  │
                                     │                                                          │
                                     │  ┌─────────────── server/ (server-only) ──────────────┐  │
                                     │  │ RunQueue (singleton on globalThis)                 │  │
                                     │  │   per-account lock · global concurrency limit      │  │
                                     │  │   └─► Runner: spawn(gallery-dl.exe, argv, shell:false)│
                                     │  │         stdout/stderr ─► LineParser ─► RunEvent     │  │
                                     │  │ Store: .gather/settings.json, runs/<id>.json, .log │  │
                                     │  │ Library: scan media root for */archive.sqlite3     │  │
                                     │  └────────────────────────────────────────────────────┘  │
                                     └──────────────────────────┬───────────────────────────────┘
                                                                │ child process (argv array)
                                                                ▼
                                            C:\tools\gallery-dl.exe ──► x.com (Firefox cookies)
                                                                │
                                                                ▼
                                            D:\Photos\p\scrapper\<acct>\{Image,Video}\, archive.sqlite3
```

### The one shared piece: `buildCommand(spec, settings) → Step[]`

A **pure function** in `src/lib/command.ts` with no Node imports. The client imports it for the live
preview, and the server imports it to actually spawn. Because both use the same code, the preview
can't drift from what runs. The server never trusts the client's argv: it rebuilds argv from the
validated `JobSpec`.

---

## 3. Data model

```ts
// src/lib/spec.ts: shared, validated with zod on the server
type SiteId = 'x' | 'instagram' | 'bluesky' | 'pixiv' | 'reddit' | 'url'
type Media = 'images' | 'videos' | 'all'
type Layout =
  | { kind: 'byType' } | { kind: 'byTypeYear' } | { kind: 'byMonth' } | { kind: 'flat' }
  | { kind: 'custom'; template: string[] }

interface JobSpec {
  site: SiteId
  account: string            // normalized handle, or full URL when site = 'url'
  folder?: string            // override for <acct> (reserved names, renames)
  media: Media
  dateFrom?: string          // ISO yyyy-mm-dd
  dateTo?: string
  layout: Layout
  simulate: boolean          // "Preview files"
  advanced: {
    imageSize: 'orig' | 'large' | 'medium'
    sleepRequest?: number; sleep?: number; sleep429?: number
    retries?: number; limitRate?: string
    filesizeMin?: string; filesizeMax?: string
    abortAfterSkipped?: number   // -A N; null = off
    range?: number               // --range 1-N
    retweets: boolean; replies: boolean
    writeMetadata: boolean; noSkip: boolean
    cookies: { browser: 'firefox' | 'chrome' | 'edge' | 'none'; profile?: string }
    proxy?: string
  }
}

interface Step { label: 'images' | 'videos' | 'all'; argv: string[] }

type RunStatus = 'queued' | 'running' | 'stopping' | 'done' | 'failed' | 'stopped' | 'interrupted'

interface Run {
  id: string                 // time-sortable, e.g. 2026-11-11T09-14-02_username
  spec: JobSpec
  steps: Step[]
  status: RunStatus
  stepIndex: number
  counts: { saved: number; skipped: number; failed: number }
  startedAt?: string; endedAt?: string
  exitCode?: number
  errorKind?: 'auth' | 'notFound' | 'rateLimit' | 'diskFull' | 'binaryMissing' | 'unknown'
}

type RunEvent =
  | { t: 'status'; status: RunStatus; stepIndex: number }
  | { t: 'file'; kind: 'saved' | 'skipped'; path: string }
  | { t: 'log'; level: 'info' | 'warning' | 'error'; line: string }
  | { t: 'wait'; reason: 'rateLimit'; seconds: number; attempt: number; of: number }
  | { t: 'counts'; saved: number; skipped: number; failed: number }
```

### Persistence: plain files under `.gather/` (git-ignored)

```
.gather/
  settings.json            gallery-dl path, media root, cookie browser/profile, defaults
  runs/<id>.json           Run record, written on status change (atomic: write tmp → rename)
  runs/<id>.log            raw stdout+stderr, appended as it streams
```

History reads `runs/*.json` (200 small files at most, pruned by the retention setting).
No SQLite of our own: gallery-dl's archives are the only databases, and **the app never opens
them for writing**.

---

## 4. Command builder: UI → gallery-dl flags

| UI | Flag(s) | Notes |
|---|---|---|
| Site X + account | URL `https://x.com/<acct>/media` | |
| Media: images | `-o twitter.videos=false -o twitter.gifs=false --filter "extension in ('jpg','jpeg','png','webp')"` | Same as the commands in AGENTS.md |
| Media: videos | `-o twitter.videos=true -o twitter.gifs=true --filter "extension in ('mp4','webm','mov','m4v')"` | |
| Media: all | Two steps: images, then videos, **sequential** in one run | Required: both steps share one archive (SQLite lock) |
| Date from / to | `--date-after`, `--date-before` | `--date-after` also ends extraction early on date-ordered feeds |
| Layout | `-o 'directory=[...]'` JSON | Built with `JSON.stringify`, so quoting is always valid (the single-quote bug in AGENTS.md can't happen) |
| Archive | `--download-archive <root>/<acct>/archive.sqlite3` | **Always** added; not a user option |
| Image size | `-o twitter.size=["orig"]` (only when not `orig`) | Default is already `orig` |
| Retweets / replies | `-o twitter.retweets=…`, `-o twitter.replies=…` | |
| Sleeps | `--sleep-request`, `--sleep`, `--sleep-429` | Omitted when 0 / default |
| Retries | `-R N` | |
| Bandwidth | `--limit-rate` | |
| File size | `--filesize-min`, `--filesize-max` | |
| Stop when caught up | `-A N` | Default on for accounts already on disk |
| Only newest N | `--range 1-N` | |
| Metadata | `--write-metadata` | |
| Overwrite | `--no-skip` | |
| Cookies | `--cookies-from-browser firefox[:profile]` | |
| Proxy | `--proxy` | |
| Preview files | `--simulate` | Prints the would-be files, writes nothing |
| (always) | `--no-colors` | Clean lines for the parser (see §5) |

Per-site differences (URL shape, which media flags exist, whether size options exist) live in one
**site registry**, `src/lib/sites.ts`: `{ id, label, urlFor(acct), handlePattern, mediaOptions(media),
supportsSize, beta }`. Adding a site means adding one entry.

The media root is passed as `-d <root>` plus an explicit `directory`, so the global
`%APPDATA%\gallery-dl\config.json` default (`["{user[name]}"]`) is always overridden, as AGENTS.md
requires.

---

## 5. Running gallery-dl

### Spawn

```ts
spawn(settings.galleryDlPath, step.argv, {
  cwd: settings.mediaRoot,
  shell: false,          // argv array, no shell parsing, so no injection via handles or templates
  windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
})
```

`PYTHONUNBUFFERED` makes lines arrive as they happen instead of in 4 KB bursts. `PYTHONIOENCODING`
keeps non-ASCII filenames intact. **Not yet verified for this exe:** some PyInstaller builds ignore
`PYTHON*` variables. Step 2 of §9 checks this. If lines arrive in bursts, counts still end correct,
only less smooth; record that and decide then whether it matters.

### Parsing output (line by line, `readline` on each stream)

| Stream | Pattern | Event |
|---|---|---|
| stdout | starts with `# ` | `file/skipped` |
| stdout | any other path line | `file/saved` |
| stderr | `[<category>][warning] …` | `log/warning`; if it mentions `429` / rate limit, also `wait` |
| stderr | `[<category>][error] …` | `log/error`; classify into `errorKind` by keyword (`login`/`401` → auth, `not found`/`suspended` → notFound, …) |
| exit | code 0 | `done`; non-zero → `failed` |

The patterns above are gallery-dl's default output. **Smoke-test them first (§9 step 2).** If they
prove fragile, switch to explicit markers with `--Print "after:@@S {_path}"` and
`--Print "skip:@@K {_path}"` and parse only `@@` lines. The parser is a pure function
`parseLine(stream, line) → RunEvent | null`, so the switch touches one file.

### Stop (Windows-specific)

The PyInstaller one-file exe **starts a second process** (a bootloader that unpacks and runs the real
interpreter). `child.kill()` only kills the bootloader, which would leave the downloader running and
holding the SQLite lock. Stop therefore runs:

```
taskkill /PID <pid> /T /F        # /T = whole process tree
```

then deletes `*.part` files under `<root>/<acct>/` (the cleanup step from AGENTS.md), then marks the
run `stopped`.

### Queue and locks

- `RunQueue` holds `queued` runs in memory and persists each `Run` record.
- **Rule:** at most one running run per account, and a global limit of 1 by default
  (setting, range 1–3). See ADR-4.
- On app start, any record still `running`/`stopping` becomes `interrupted`, and its account folder
  gets the `.part` sweep.

### Singleton survives dev reloads

```ts
const g = globalThis as unknown as { __gatherQueue?: RunQueue }
export const runQueue = (g.__gatherQueue ??= new RunQueue())
```

Without this, every hot reload in `next dev` would create a new queue and lose track of the running
child processes. (This is the deliberate exception to `server-no-shared-module-state`: the state is
process-wide by design, not per-request.)

---

## 6. Next.js structure

### 6.1 Folder layout (repo = workspace root)

```
D:\Photos\p\scrapper\
├─ AGENTS.md  skills-lock.json  .agents/  .claude/        (existing tooling, unchanged)
├─ username/  yearacct/  …                              (media, git-ignored, never touched by the build)
├─ docs/                     DESIGN.md · ARCHITECTURE.md · design-system/ (tokens, brand book, component specs)
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx          fonts (next/font), top bar
│  │  ├─ globals.css         tokens (@theme) + base styles
│  │  ├─ page.tsx            Run (RSC shell)
│  │  ├─ actions.ts          'use server': startRun, stopRun, saveSettings
│  │  ├─ library/page.tsx
│  │  ├─ history/page.tsx
│  │  ├─ history/[id]/page.tsx
│  │  ├─ settings/page.tsx
│  │  └─ api/
│  │     ├─ runs/[id]/events/route.ts   SSE
│  │     └─ open-folder/route.ts        POST → explorer.exe <path>
│  ├─ components/            run-form.tsx, run-panel.tsx, icons.tsx,
│  │                         ui/ (the 11 design-system components, one file each: button.tsx, text-field.tsx, …)
│  ├─ lib/                   shared, no Node APIs: spec.ts, sites.ts, command.ts, parse-line.ts, format.ts
│  └─ server/                'server-only': run-queue.ts, runner.ts, store.ts, library.ts, paths.ts
├─ public/                   favicon only
├─ (src/proxy.ts)            Host-header guard (see §7). Must sit inside src/, or Next ignores it.
├─ next.config.ts  tsconfig.json  postcss.config.mjs  package.json
├─ .gather/                  runtime state (git-ignored)
├─ .next/  node_modules/     (git-ignored)
```

Using `src/` keeps everything the app owns inside one folder, apart from the root config files, so
the workspace root stays readable and `.gitignore` only needs to re-include `src/`, `public/`, `docs/`.

### 6.2 Living next to gigabytes of media

| Risk | Mitigation |
|---|---|
| `next build` output tracing follows a dynamic `fs` path and pulls account folders into the trace | Media paths come from `settings.mediaRoot` at runtime, never from `path.join(process.cwd(), …)` in module scope. Add `outputFileTracingExcludes: { '*': ['./*/Image/**', './*/Video/**', './**/*.sqlite3'] }` in `next.config.ts` (rule `bundle-analyzable-paths`). |
| Dev server file watcher walks the media folders | `tsconfig.json` `include: ["src", "next-env.d.ts", …]`, not `**/*`. Turbopack only follows the import graph. Verify in step 1 by watching CPU on `next dev`. |
| An X handle equal to an app folder (`src`, `public`, `docs`, `node_modules`, `.next`, `.gather`) | `paths.ts` has a `RESERVED` set; such runs require the *Folder name* override. Library only lists folders that contain `archive.sqlite3`. |
| Path traversal through the account or folder field | Handle validated by the site regex. Folder override must match `^[A-Za-z0-9_.-]{1,64}$`. Final path is resolved and must start with `mediaRoot + sep`. |
| `.gitignore` rule `/*/` hides the new source folders | Add `!/src/`, `!/public/`, `!/docs/` (`docs/` is already done). |

### 6.3 Rendering and data flow (Vercel React rules applied)

| Concern | Choice | Rule |
|---|---|---|
| Pages | Server Components by default. Only the form, run panel, copy button, and library filter are client components. | `server-serialization` |
| Initial data | `page.tsx` fetches settings, the library summary, and the active run with `Promise.all` | `async-parallel` |
| Library scan | Folder stats (file counts, sizes) can take seconds on large accounts. Stream them: the table shell renders now, and a `<Suspense>` boundary fills sizes in. Results are memoized per account with mtime as the key. | `async-suspense-boundaries`, `server-cache-lru` |
| Starting a run | Server Action, then `revalidatePath('/history')` | |
| Live progress | Route Handler returning a `ReadableStream` as `text/event-stream`, with `export const dynamic = 'force-dynamic'` and `runtime = 'nodejs'`. On connect it replays the run's buffered events (last 500 lines + counts), so a reload or a second tab catches up. | |
| Client progress state | Counters are batched: events accumulate in a ref and are flushed to state with `requestAnimationFrame`. That gives at most 60 renders/s even when thousands of `#` skip lines arrive. | `rerender-use-ref-transient-values`, `rerender-transitions` |
| Command preview | Derived during render from form state with `buildCommand`. No effect, no extra state. | `rerender-derived-state-no-effect` |
| Long logs | `content-visibility: auto` on log rows. The panel keeps only the last 500 lines; the full log is on the History page. | `rendering-content-visibility` |
| Imports | Direct file imports, no `index.ts` barrels. `ui/` components imported one by one. | `bundle-barrel-imports` |
| Fonts | `next/font/google` for Schibsted Grotesk + Fragment Mono, `display: 'swap'`, subsets `latin` | `server-hoist-static-io` |

Why SSE and not WebSockets: traffic only flows one way (server → browser), SSE works with a plain
Route Handler, reconnects on its own, and needs no extra server or package.

---

## 7. Security (local but not careless)

| Threat | Control |
|---|---|
| Another device on the LAN uses the app | `next start -H 127.0.0.1 -p 3210` in the `start` script. Never `0.0.0.0`. |
| A malicious website in the same browser fires requests at `localhost:3210` (CSRF / DNS rebinding) | Server Actions check `Origin` against `Host` out of the box. `proxy.ts` also rejects any request whose `Host` is not `127.0.0.1:3210` / `localhost:3210`, which blocks DNS rebinding for Route Handlers too. |
| Shell injection through form fields | `spawn` with an argv array and `shell: false`. zod validation. Templates only allow `{key}` / `{key:%fmt}` tokens from an allowlist. |
| Leaking cookies | The app never reads or stores cookies; gallery-dl reads Firefox directly. Logs are written as-is, but the run-detail page masks values that look like `auth_token=` / `ct0=`. |
| Writing outside the media root | Path resolution check (§6.2). |

---

## 8. Architecture decision records

### ADR-1: Next.js app in the workspace root (not a subfolder)

- **Decision:** Next.js 16 project files live directly in `D:\Photos\p\scrapper`, with app code under `src/`.
- **Why:** User requirement. Also, the media folders and the app share one root path, which keeps
  `mediaRoot` the default.
- **Trade-offs:** Account folders and framework folders share a namespace (reserved-name guard
  needed). `.gitignore` must re-include source folders. AGENTS.md's "not a code repo" line becomes
  outdated and must be updated when scaffolding.
- **Revisit if:** media moves to another drive; just change `mediaRoot` in Settings.

### ADR-2: Shell out to the CLI; don't reimplement extraction

- **Decision:** Drive `gallery-dl.exe` through `child_process.spawn`. No Python bridge, no port of extractors.
- **Why:** gallery-dl is a frozen exe (it can't be imported), its 287 site modules are maintained
  upstream, and `gallery-dl -U` keeps them current. Its CLI is a stable contract.
- **Trade-offs:** Progress comes from parsing text output, and there is no total count up front.
  Mitigated by a single pure parser and the `--Print` marker fallback.
- **Rejected:** gallery-dl's `-S` server mode (it only accepts URLs, so per-run options and
  per-run progress are lost); running in Docker (adds a daemon for one exe).

### ADR-3: Plain JSON files for state, not a database

- **Decision:** `.gather/settings.json` plus one JSON and one log file per run.
- **Why:** One user, at most hundreds of records, no queries beyond "list recent". No native module
  to compile (better-sqlite3), and nothing experimental (`node:sqlite`).
- **Trade-offs:** No cross-run queries (for example "total GB downloaded this month"). Library
  stats come from the file system instead.
- **Revisit if:** History needs search or aggregation. Then move to `node:sqlite` in `.gather/gather.db`.

### ADR-4: Queue with per-account lock and a global concurrency limit

- **Decision:** One run per account at a time (hard rule). Global limit **1** by default, adjustable up to 3.
- **Why:** Two writers on one `archive.sqlite3` hit SQLite lock errors (AGENTS.md). Runs for
  different accounts share the same logged-in X session and the same rate-limit budget, so
  parallel runs mostly trigger 429s sooner rather than finishing faster.
- **Trade-offs:** "Update all" over many accounts is serial and slow. Acceptable for a background task.
- **Revisit if:** previews feel slow behind long downloads (see §8.1).

#### 8.1 Scheduling rule

Strict on purpose: previews (`--simulate`) wait like downloads, because gallery-dl still opens the
account's `archive.sqlite3` to read it. Letting previews skip the account lock or the global limit
is a one-line change here if the wait becomes annoying.

```ts
// src/server/run-queue.ts
function canStart(next: Run, running: Run[], limit: number): boolean {
  return running.length < limit && !running.some((run) => sameFolder(run, next));
}
```

### ADR-5: SSE Route Handler for progress

- **Decision:** `GET /api/runs/[id]/events` streams `RunEvent`s as Server-Sent Events. The client
  uses `EventSource`.
- **Why:** One-way data, built-in browser reconnect, works in a Route Handler with Web Streams (Next 16.4 docs).
- **Rejected:** Polling (laggy, wasteful during 10k-file runs). WebSockets (need a custom server,
  which conflicts with `next start`).

### ADR-6: Tailwind v4 tokens + own components, no component library

- **Decision:** Tokens from the design system's `tokens.json` go into `globals.css` via `@theme`.
  The 11 design-system components are written by hand with the props in its `index.d.ts`, on native
  elements (`details`, radios, `input type="date"`). No shadcn/ui, no date-picker or icon library.
- **Why:** The look (monochrome, hairlines, no tints or pills) is the opposite of shadcn's defaults,
  so restyling it would cost more than writing ~11 small components. Native elements give keyboard and
  screen-reader support for free. `create-next-app` for Next 16 sets up Tailwind v4 by default. (The
  Tailwind v3 note in your global CLAUDE.md is about the Laravel stack.)

### ADR-7: Not deployable; local `next start`

- **Decision:** Production mode is `next build && next start -H 127.0.0.1 -p 3210`, started by hand or
  from a Windows shortcut. No Vercel project.
- **Why:** The app spawns a local exe and writes to a local drive.
- **Consequence:** `vercel-optimize` does not apply. Performance work follows the Vercel React rules
  in the codebase.

---

### ADR-8: Cache Components off

- **Decision:** `next.config.ts` has no `cacheComponents` and no `partialPrefetching`, although the
  Next 16.4.6 `create-next-app` template enables both.
- **Why:** With Cache Components on, Next 16 removes the `dynamic` and `runtime` route segment
  exports, so the SSE handler in §6.3 (`dynamic = 'force-dynamic'`, `runtime = 'nodejs'`) would fail
  the build. Every page here reads live process and file system state, so there is nothing worth
  prerendering or caching across requests.
- **Revisit if:** the app ever serves slow-changing data worth caching. Then adopt `use cache` per
  function and drop the segment exports from the SSE route.

## 9. Build order (each step ends with something that works)

1. **Scaffold at the root:** `npx create-next-app@latest . --ts --tailwind --app --src-dir
   --no-eslint --import-alias "@/*"` (it will ask about the non-empty folder). Update `.gitignore`
   re-includes and `tsconfig.include`. Check that `next dev` stays idle on CPU.
2. **Parser smoke test (no UI):** run a 2-file `gallery-dl --range 1-2` for one known account and
   save the raw stdout/stderr to `src/lib/__fixtures__/`. Write `parseLine` against the real lines,
   including one `#` skip run and one forced error (a bad handle).
3. **`command.ts` + `sites.ts` (X only).** Snapshot-test the argv for each preset against the
   commands in AGENTS.md: they must match flag for flag.
4. **Runner + RunQueue + Store**, driven from a throwaway script. Test Stop with `taskkill /T`
   and confirm in Task Manager that no `gallery-dl.exe` is left over.
5. **SSE route + RunPanel.**
6. **RunForm** with the live CommandPreview, then Preview files (`--simulate`), then Download.
7. **Library** (stream sizes with Suspense), then **History**, then **Settings**.
8. **Beta sites:** for each, smoke-test with `--range 1-2`, then drop the beta flag.
9. Update AGENTS.md: it becomes a code repo, with new run commands and folder rules.

## 10. Testing

| Layer | What | How |
|---|---|---|
| `command.ts`, `parse-line.ts`, `spec.ts` | Pure functions, which hold most of the logic | Vitest unit tests with fixtures from real gallery-dl output |
| Runner | Spawn, stream, stop, `.part` cleanup | Integration test with a fake exe (a small Node script that prints fixture lines and sleeps) |
| UI | Form → preview → run panel states | Manual check against the DESIGN.md state tables. One Playwright happy path later if wanted. |

## 11. What to revisit as it grows

- **Scheduled updates** ("update all accounts nightly"): add a Windows Task Scheduler entry that
  calls a small endpoint or CLI script. Don't add a cron library to the app.
- **Thumbnails in Library:** needs a resize step (sharp) and a cache folder. Left out of v1 to
  keep it lean.
- **Post-processing** (zip, exec hooks): gallery-dl supports it. Expose it only if a real use comes up.
- **Concurrency > 1** works only if 429 rates stay low. Measure before raising the default.
