# TextField

A labelled single-line input with an optional hint or error underneath. Used for the account, numbers in Advanced and the custom folder template.

- Always give a visible `label`. Placeholders are examples, never the label.
- Use `prefix="@"` for X handles and `mono` for anything machine-like (handles, sizes such as `2M`, templates).
- `error` replaces the hint, turns the border `danger` and is announced with the input.
- Dates use the native `type="date"`: no date-picker library.
- Provide: `label`, `value`/`onChange` (or `defaultValue`), optional `hint`, `error`, `prefix`, `mono`, any input attribute.
