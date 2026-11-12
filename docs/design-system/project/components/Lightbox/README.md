# Lightbox

Opens over the grid when a thumbnail is chosen. The URL gains `?file=<name>`, so a reload keeps the place and Esc returns focus to the tile.

- Ground is the `stage` token (near-black) with `on-stage` for text and controls. It looks the same in the light and dark themes. The focus ring switches to `on-stage` inside it.
- The original, fit to the screen. Scroll or pinch to zoom, double-click for 100 percent, drag to pan. Videos use native controls.
- Keys: left and right move between files, Esc closes, `F` fullscreen, `I` details, Space plays or pauses a video.
- A visible "3 of 128" counter. The details panel (filename, size, dimensions, post date, link to the post) is hidden by default.
- `role="dialog"` with `aria-modal`, a focus trap, and the image's alt text is its filename.
- Delete asks first and says that the archive still remembers the file, so a later run will not bring it back.
- Provide: `name`, `position`, `total`, `actions`.
