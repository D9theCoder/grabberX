# Button

Buttons start or stop a run. Use `primary` once per view, for Download; `secondary` for Preview files; `ghost` for Copy, Open folder and other low-weight actions; `danger` for Stop and Cancel.

- Labels are verbs in sentence case: "Download", "Preview files", "Run again".
- Set `loading` while a click is in flight: a spinner sits before the label and the width stays put.
- Never leave a disabled button unexplained. Put the reason in a `small` hint under it ("Enter an account first").
- Provide: `children` (label), `onClick`, optional `variant`, `size`, `loading`, `disabled`.
