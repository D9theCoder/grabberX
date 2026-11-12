# ThemeToggle

The light/dark switch in the top bar. A 40px icon button just left of the Settings gear.

- Shows the moon in light and the sun in dark: the icon is the theme you switch to. Its `aria-label` and tooltip say the same in words ("Switch to dark mode").
- `ink-2` at rest, `ink` on a `sunken` fill on hover, the usual `focus` outline.
- A click sets `<html data-theme>` and saves the choice. The page cross-fades in 200ms; under `prefers-reduced-motion` it switches at once.
- Until someone clicks it, the app follows the operating system. Settings → Appearance (System, Light, Dark) is the place to go back to System.
- Provide: `theme`, `onChange`.
