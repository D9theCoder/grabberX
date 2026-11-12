# SelectionBar

The bar for select mode in the gallery. It sticks to the bottom of the window, inside the 1120px container, while select mode is on.

- Enter select mode with the Select button above the grid, the `S` key, Ctrl+A, the context menu's Select, or by starting a drag on empty grid space. Leave it with Done or Esc.
- Left: the count in `label` weight 600, tabular numerals ("12 files selected"). Then Select all and Clear as ghost buttons.
- Right: Download (secondary), Delete (danger), Done (ghost). Download and Delete are disabled with nothing selected.
- Download saves one file as itself and several as one zip. Delete asks once, naming the count, then moves the files to the Recycle Bin in the desktop app or deletes them for good from `npm run dev`; the archive is never touched, so nothing re-downloads.
- `surface` fill, `line-strong` border, `radius-lg`, no shadow. On phones the buttons wrap under the count.
- Provide: `count`, `onSelectAll`, `onClear`, `onDownload`, `onDelete`, `onDone`.
