# Thumbnail

One tile in the gallery grid. A button named after the file, so screen readers and keyboard users get "1800000000000000001_1.jpg", not "image".

- Keeps the file's aspect ratio; rows are justified to the container width. 1px `line` border, `ink-2` on hover and for the tile that holds the arrow-key focus.
- Images load a small WebP, never the original. Videos show their first frame, a play glyph and the length.
- Only one tile in the grid takes Tab. Arrow keys move between tiles, Enter opens the Lightbox.
- Provide: `name`, `width`, `height`, `kind`, `duration`, `active`.
