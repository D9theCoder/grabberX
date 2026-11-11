gather is a quiet, local front end for `gallery-dl`. It should feel like a well-set form on good paper: ink, hairlines, and nothing that asks for attention except the thing you're about to do.

## Principles

- **Monochrome first.** Build every screen in `ink`, `ink-2` and greys on `paper`. Color means something went wrong (`danger`) or you have to wait (`warn`). Nothing else gets color, not even success.
- **Select with ink, not tint.** A chosen option is an `ink` fill with `on-ink` text (segments) or an `ink` radio plus a 600-weight label (lists). Never a pale tinted fill with a colored border.
- **Words carry status.** Status is sentence-case text with a small glyph: "Running", "Done", "Failed". No pills, no badges, no uppercase letter-spaced labels, no colored dots.
- **Borders, not shadows.** `shadow-none` everywhere. Hairline `line` between things you read, `line-strong` around containers, `control` around things you type into.
- **Show the command.** The exact `gallery-dl` command is always visible in a `CommandBlock`, in `code`.

## Color

- Page: `paper`. Inputs and the segmented track: `surface`. Logs and the command body: `sunken`.
- Text: `ink` for anything people read. `ink-2` for hints, placeholders, counter labels and skipped log lines. `ink-3` is for disabled text only.
- Primary button and selected segment: `ink` fill, `on-ink` text, `ink-hover` on hover.
- `danger` on paper or sunken for error text, the failed status, field error borders, and Stop/Cancel labels. It always appears next to a word or a ✕.
- `warn` for rate-limit waits, queue messages and the layout-differs notice. Text and icon only, never a filled background.
- There is no accent and no green. A finished run says "Done" in `ink` with a check.

## Type

- Set the interface in **Schibsted Grotesk** (`sans`) and anything a machine reads (commands, paths, handles, logs) in **Fragment Mono** (`mono`). Both load from Google Fonts. In Next.js use `next/font/google`.
- Styles: `display` for the one page title, `title` for section headings, `body` default, `label` for labels and buttons, `small` for hints and status, `stat` for run counters, `code` for commands and paths, `log` for log lines.
- Sentence case everywhere: "Preview files", not "Preview Files". No uppercase eyebrows.
- Counters use `font-variant-numeric: tabular-nums` so digits don't jitter while counting.

## Space, size and shape

- 4px base: `space-1` … `space-12`. Sections are separated by `space-8` and a `line` hairline, not by boxes.
- Controls are 40px tall (`--spacing-control`), including every `Segmented` track at either size; 44px touch height on phones.
- Corners: `radius-md` on controls, `radius-lg` on the command block and run panel, `radius-sm` on segment options. Nothing is pill-shaped.
- Run screen: 1120px max container. The form column is fluid, the command/run column is 400px and sticky. Below 1024px it's one column, with a sticky bottom bar holding the two run buttons.
- Page containers: 1120px on Run, Library and History; the title row keeps one fixed height on every page. Settings is deliberately narrow (max 672px), read one field at a time.

## States

- Hover: borders darken to `ink-2`. Ghost buttons and segment options get a `sunken` fill.
- Focus: `focus` outline, 2px solid, 2px offset, on every interactive element. Never removed.
- Disabled: `sunken` fill, `ink-3` text, no border, `cursor: not-allowed`. Always explain why in a hint next to it. A disabled `primary` keeps a 15% ink fill and ink text (about 13:1), so it still reads as the primary action.
- Loading: a 12px ring spinner in `currentColor` replaces nothing. It sits before the label, and the button keeps its width.
- Motion: 120ms for hover/press, 200ms for disclosure. Only the spinner loops. Everything is off under `prefers-reduced-motion`.

## Writing

- Plain, short, second person, no exclamation marks. Say **run**, **account**, **files**. Never "job", "scrape" or "extractor".
- Buttons are verbs: **Download**, **Preview files**, **Stop**, **Update**, **Run again**, **Open folder**.
- Errors say what happened and what to do: "X asked for a login. Open x.com in Firefox, sign in, then run again."

## Iconography

- No icon library. About ten inline SVG icons drawn on a 24px grid with a 1.75px stroke, round caps, `currentColor`: check, cross, chevron, copy, folder, clock, alert, info, stop, play, external, gear, more.
- Icons sit next to words, never instead of them, except the copy button (`aria-label="Copy command"`).
- No emoji, no logos of the sites gallery-dl supports. Sites are named in plain text.

## Components

Use the components in this system (`window.Gather` in previews; in the app, React components with the same props, styled from these tokens):

- `Button`: `primary` once per view (Download), `secondary` for the alternative (Preview files), `ghost` for low-weight actions, `danger` for Stop/Cancel.
- `TextField`: account, numbers, dates. Optional `prefix` (e.g. `@`) and `mono`.
- `Segmented`: one choice from a short set (site, media, date preset). Wraps when it runs out of room, on phones too, so no option is clipped. One height at every size.
- `ChoiceList`: one choice where each option needs a second line (folder layouts).
- `Switch`: on/off settings in Advanced.
- `Disclosure`: the folded Advanced section, with a count of changed values.
- `CommandBlock`: the command preview with Copy.
- `Status`, `Stat`, `LogView`, `Notice`: the run panel.
- `Breadcrumb`, `FolderCard`, `Thumbnail`: browsing an account's media (`/library/[account]`).
- `Toolbar`, `Lightbox`: viewing one file. The only place the `stage` token (near-black, with `on-ink` controls) appears. It is a documented exception for looking at media, not a dark theme.
