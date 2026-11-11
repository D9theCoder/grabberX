# Notice

An inline message next to the thing it is about: a rate-limit wait, a queue position, a failed run, a layout change. No box and no tinted fill: an icon and words.

- `warning` for waits and cautions, `danger` for failures, `info` for neutral context.
- Title says what happened; body says what to do. Add an `action` button when there is one obvious fix.
- Danger notices are announced (`role="alert"`); the rest are polite.
- Provide: `tone`, `title` and/or `children`, optional `action`.
