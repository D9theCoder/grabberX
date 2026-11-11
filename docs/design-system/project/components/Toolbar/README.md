# Toolbar

A row of icon buttons for the lightbox. It sits on the `stage` ground, so buttons use `on-ink`: transparent at rest, a 15% `on-ink` fill on hover, and the same fill plus a border when pressed.

- Each button is 44px square, has an `aria-label`, and shows the same text as a tooltip on hover and keyboard focus. Icons are never used without that label.
- Toggles (Details, Loop, Autoplay) set `aria-pressed`.
- The container is `role="toolbar"` with its own label.
- Provide: `label`, `actions` (`label`, `icon`, `pressed`, `disabled`).
