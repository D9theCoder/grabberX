# Stat

A single run counter: a big tabular number with a small label. Always three in a row: saved, skipped, failed.

- gallery-dl doesn't know the total up front, so there is no percentage and no progress bar. Counters only.
- `saved` is default tone, `skipped` is `muted`, `failed` is `danger` only when above zero.
- The whole stat is one accessible label ("312 saved"), announced at phase changes, never per file.
- Provide: `value`, `label`, optional `tone`.
