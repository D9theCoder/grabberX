# Thumbnail

One tile in the gallery grid. A button named after the file, so screen readers and keyboard users get "1800000000000000001_1.jpg", not "image".

- Keeps the file's aspect ratio; rows are justified to the container width. 1px `line` border, `ink-2` on hover and for the tile that holds the arrow-key focus.
- Images load a small WebP, never the original. Videos show their first frame, a play glyph and the length.
- Only one tile in the grid takes Tab. Arrow keys move between tiles, Enter opens the Lightbox.
- Images load a cached WebP thumbnail with a long-lived cache header; videos show a cached poster frame once one exists and never keep a playing `<video>` per tile.
- Select mode (`selectable`): a 20px check box in the top-left corner; a selected tile gets a 2px `ink` inset outline and a filled check. The tile becomes a toggle (`aria-pressed`). Click toggles, Shift+click selects the range, and press-and-drag on the grid draws the `g-marquee` rectangle and selects every tile it touches. Ctrl+A selects all, Esc leaves select mode.
- Right-click opens the `ContextMenu` for that tile; in select mode it acts on the whole selection when the tile is part of it.
- Provide: `name`, `width`, `height`, `kind`, `duration`, `active`, `selectable`, `selected`.
