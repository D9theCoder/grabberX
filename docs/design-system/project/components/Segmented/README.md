# Segmented

Pick one option from a short set: the site, the media type, a date preset. The chosen option is filled with `ink`; the rest are `ink-2` text.

- Keep labels to one or two words. Use `tag` for a quiet qualifier ("beta") only on a short set; a long set moves the qualifier next to what it qualifies (the site's beta tag sits on the Account label).
- Arrow keys move the choice; Tab enters and leaves the group.
- **One row from 640 px up.** Budget the width before adding an option: at md each option is its label plus 28 px, and the Run form gives a control about 470 px at its narrowest. A ragged wrap (one option alone on a second row) is a defect; shorten labels, drop tags, or widen the section instead.
- **Phones:** pass `columns` (2–4) for a set that cannot fit 358 px; the options become an even grid with equal cells. Without `columns` the control still wraps rather than clip, as a guard only.
- One height at every size; 44px touch height on phones.
- Provide: `label` (accessible name), `options`, `value`/`onChange` or `defaultValue`, optional `size` and `columns`.
