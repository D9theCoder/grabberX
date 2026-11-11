# LogView

The tail of gallery-dl's output. Skipped files (lines starting with `# `) are `ink-2`, warnings `warn`, errors `danger`, saved files `ink`.

- The run panel shows the last 6 lines and expands to 320px. History shows the full log.
- Keep at most 500 lines in the browser. Rows use `content-visibility: auto` so long logs stay smooth.
- Auto-scroll only while the reader is at the bottom.
- Provide: `lines` (strings or { text, level }), optional `maxLines`, `maxHeight`, `label`.
