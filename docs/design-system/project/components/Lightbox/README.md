# Lightbox

Opens over the grid when a thumbnail is chosen. The URL gains `?file=<name>`, so a reload keeps the place and Esc returns focus to the tile.

- Ground is the `stage` token (near-black) with `on-stage` for text and controls. It looks the same in the light and dark themes. The focus ring switches to `on-stage` inside it.
- The original, fit to the screen. Scroll or pinch to zoom, double-click for 100 percent, drag to pan.
- Videos use the app's own control bar under the stage, never the browser's, so zoom scales only the picture. It holds play or pause, back and forward 5 seconds, a seek slider with time, mute and volume, a short stepped speed slider on the same row, shown by the speed button (0.1×, 0.25×, then 0.25× steps to 3×; double-click it to reset to 1×) and fullscreen. Fullscreen is the viewer's, not the video's, so zoom keeps working in it.
- On a video, double-click (double tap on the phone) the left third to skip back 5 seconds, the right third to skip forward 5 seconds, the middle to toggle zoom. A single click or tap plays or pauses.
- Autoplay, volume and mute are remembered between visits. Speed and Loop are not: each viewer starts at 1× with loop off.
- Keys: left and right move between files, Esc closes, `F` fullscreen, `I` details, Space plays or pauses a video.
- A visible "3 of 128" counter. The details panel (filename, size, dimensions, post date, link to the post) is hidden by default.
- `role="dialog"` with `aria-modal`, a focus trap, and the image's alt text is its filename.
- Delete asks first and says that the archive still remembers the file, so a later run will not bring it back.
- Provide: `name`, `position`, `total`, `actions`.
