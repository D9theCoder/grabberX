# Status

The state of a run, as a word with a small glyph. Used in the run panel header, the Library table and History.

- Words: Queued, Running, Stopping, Done, Failed, Stopped, Interrupted. Sentence case, never uppercase, never inside a pill.
- Only Failed takes color (`danger`). Done is `ink` with a check. Queued, Stopped and Interrupted are `ink-2`.
- Running and Stopping show the spinner. Put the account and elapsed time in `children`.
- Provide: `state`, optional `children`.
