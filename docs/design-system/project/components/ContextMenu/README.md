# ContextMenu

The app's own right-click menu. It replaces the browser's menu on gallery tiles, folder cards, the grid background and the lightbox, in the desktop app and in a browser alike.

- `surface` fill, `line-strong` border, `radius-md`, no shadow, 4px inner padding. Items are 36px: a 16px icon in `ink-2`, the label in `ink`, an optional shortcut in `mono`.
- Destructive items (Delete, Move to Recycle Bin) use `danger` for the label and icon and come last, after a separator.
- Opens at the pointer, flipped to stay inside the window. Also opens with the Menu key or Shift+F10 on the focused tile, anchored to the tile.
- Arrow keys move, Enter chooses, Esc or a click outside closes and returns focus to the tile.
- Text fields keep the native menu (cut, copy, paste). Everywhere else the browser menu is suppressed.
- Tile items: Open, Open in new window (browser) or Open with default app (desktop), Show in folder, Download, Copy image, Copy path, Select, then Delete. With several files selected the labels carry the count ("Download 12 files").
- Provide: `label`, `items` (`label`, `icon`, `shortcut`, `danger`, `disabled`, `onSelect`), `"-"` for a separator.
