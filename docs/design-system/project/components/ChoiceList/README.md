# ChoiceList

Pick one option when each option needs a second line to explain it. Used for folder layouts, where the second line is the path it produces.

- Rows are separated by `line` hairlines. No boxes, no fills.
- The chosen row has an `ink` radio and a 600-weight label. Nothing else changes.
- Put a machine-readable preview in `detail` (it is set in `code` and truncates with an ellipsis).
- Provide: `options` ({ value, label, detail }), `value`/`onChange` or `defaultValue`, optional `legend`.
