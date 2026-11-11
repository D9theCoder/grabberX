# CommandBlock

The exact `gallery-dl` command the run will execute, always visible next to the form, with Copy. When Media is All it shows two steps (images, then videos) as tabs.

- One flag per line, each line ending in a backtick so it pastes straight into PowerShell.
- Long values wrap inside the block so nothing is cut off; each flag still starts its own line, and Copy takes the unwrapped command.
- Values are `ink`, flags `ink-2`: the values are what change between runs.
- Never edit the command here. It is generated from the form, and the server rebuilds it before running.
- Provide: `command` or `steps` ({ label, command }), optional `onCopy`.
