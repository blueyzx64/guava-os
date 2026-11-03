# Styling with St CSS (stylesheet.css, theme nodes, dark/light, accent)

Summary: what St's CSS subset supports, how extension stylesheets are loaded (including dark/light variants), and how to read theme values from JS via `St.ThemeNode`.
It also covers the 47+ accent color, how to override Shell styles without breaking other themes, and the limits (no backdrop-filter).
Verified against gnome-shell `src/st/st-theme-node.c`, `st-settings.c`, `st-theme-context.c`, `js/ui/extensionSystem.js`, `js/ui/main.js` (main) and `data/theme/gnome-shell-sass/`.

## Contents
1. How stylesheets load
2. Supported CSS (and not)
3. St-specific properties and functions
4. Dark/light and accent color
5. Reading styles from JS
6. Overriding Shell styles safely
7. Sources

## 1. How stylesheets load
- The Shell picks the first file that exists:
  `<sessionMode>-<variant>.css`, `stylesheet-<variant>.css`,
  `<sessionMode>.css`, `stylesheet.css`. `<variant>` is `dark` or `light` from
  `Main.getStyleVariant()`. The file is reloaded when `St.Settings`
  `color-scheme` changes (extensionSystem.js).
- `getStyleVariant()` follows the session mode's colorScheme
  (`force-dark`, `force-light`, `prefer-dark`, `prefer-light`) and the user's
  `org.gnome.desktop.interface color-scheme`.
- Never call `theme.load_stylesheet()` for your own `stylesheet.css` (EGO-X-005).
  Loading *extra* sheets at runtime is possible
  (`St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file)`)
  but you must call `unload_stylesheet()` in `disable()`. Guava refreshes panel
  styling on stylesheet changes (git log a22a743).
- Guava ships one big `stylesheet.css` (about 28 KB). Prefix every selector with
  a Guava class (`.guava-…`) or a feature-scoped class added in `enable()` and
  removed in `disable()`, so the CSS only applies while the feature is on.

## 2. Supported CSS (and not)
Supported (from `st-theme-node.c` property parsing):
- `color`, `background`, `background-color`, `background-image`,
  `background-position`, `background-repeat`, `background-size`
- `background-gradient-direction`, `-start`, `-end` (St gradients, not
  `linear-gradient()`)
- `border`, `border-*` (`-width`, `-color`, `-radius` incl. per-corner
  `-top-left`, …), `border-image`
- `outline`, `padding`, `margin`, `width`, `height`, `min-*`, `max-*`
- `font`, `font-family`, `font-size`, `font-style`, `font-variant`,
  `font-weight`, `font-feature-settings`, `letter-spacing`, `text-align`
  (start/end in 51), `text-decoration`, `text-shadow`
- `box-shadow`: one shadow; `inset` is allowed; offsets, blur and spread are
  parsed from a single term list
- `transition-duration` (applies to St style transitions), `icon-size`,
  `spacing`, `-st-icon-style`, `-st-natural-width`/`-height`, `-st-background-image-shadow`
- Selectors: type (`StLabel`), `.class`, `#id` (actor name), descendant and
  child combinators, pseudo-classes such as `:hover`, `:active`, `:checked`,
  `:focus`, `:insensitive`, `:selected`

Not supported: `backdrop-filter`, `filter`, `opacity` (set `actor.opacity` in
JS), `transform`, `@media`, `calc()`, `var()`, CSS animations or keyframes,
multiple box-shadows, `linear-gradient()`. Use Clutter effects and `ease()`
instead (blur-shaders-and-effects.md).

## 3. St-specific properties and functions
- Colour functions (47+): `st-mix(c1, c2, factor)`, `st-lighten(c, amount)`,
  `st-darken(c, amount)`, `st-transparentize(c, amount)`. Amounts are
  percentages or numbers. The Shell's own sass uses them, for example
  `st-darken(-st-accent-color, 20%)`.
- Named colours: `-st-accent-color`, `-st-accent-fg-color` (47+), plus
  `error-color`, `success-color` and `warning-color` lookups.
- Layout hints: `-natural-hpadding`, `-minimum-hpadding` (panel buttons),
  `spacing` (BoxLayout).

## 4. Dark/light and accent color
- Variants: ship `stylesheet-dark.css` and `stylesheet-light.css` only if the
  difference is large. Otherwise keep one file and use the accent and
  transparent colours. `gnome-extensions pack` auto-includes both variant
  files.
- Accent: `org.gnome.desktop.interface accent-color` (47+). From JS:
  `St.Settings.get().accent_color` (an `St.SystemAccentColor` enum). The
  resolved colours: `const [accent, accentFg] =
  St.ThemeContext.get_for_stage(global.stage).get_accent_color()` (Cogl.Color
  out-params, 47+). `-st-accent-color` is a CSS *value* keyword
  (`color: -st-accent-color;`), not a property, so `lookup_color()` on that
  name finds nothing (st-theme-node.c `term_is_accent_color`).
- High contrast: `St.Settings.get().high_contrast`. Liquid Glass must degrade
  to opaque backgrounds when it is set.

## 5. Reading styles from JS
```js
widget.connect('style-changed', () => {
    const node = widget.get_theme_node();
    const radius = node.get_border_radius(St.Corner.TOPLEFT);
    const [found, len] = node.lookup_length('-guava-glass-radius', false); // custom property
    const color = node.get_background_color();      // Cogl.Color (47+; Clutter.Color before)
});
```
- Custom properties starting with `-guava-` are allowed. St ignores unknown
  properties, and `lookup_length`, `lookup_color` and `lookup_double` read them.
- `St.ThemeContext.get_for_stage(global.stage).scale_factor` gives the HiDPI
  scale. Multiply any pixel values you compute in JS by it.

## 6. Overriding Shell styles safely
- Shell selectors: `#panel`, `#panel .panel-button`,
  `.panel-status-indicators-box`, `.quick-settings`, `.quick-toggle`,
  `.quick-menu-toggle`, `.quick-slider`, `.notification-banner`,
  `.message-list`, `.popup-menu`, `.popup-menu-content`, `.modal-dialog`,
  `.search-entry`, `#overview`, `.dash-background`. Take them from
  `data/theme/gnome-shell-sass/widgets/*.scss` for the target version.
  Class names change between releases (48 renamed QuickMenuToggle classes).
- Scope overrides with a class you add to a container in `enable()`, for
  example `Main.panel.add_style_class_name('guava-glass')`, and remove it in
  `disable()`. Then `.guava-glass .panel-button {}` disappears cleanly.
- Users with custom Shell themes (User Themes extension) can override you.
  Guava documents that it is tested with vanilla Adwaita.
- `!important` is honoured: st-theme.c `get_origin()` ranks important
  declarations above normal ones (and extension sheets above both). Otherwise
  higher specificity wins.

## 7. Sources
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/st/st-theme-node.c
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/st/st-settings.c (accent-color, color-scheme, high-contrast, reduced-motion)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/extensionSystem.js (_loadExtensionStylesheet)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/data/theme/gnome-shell-sass
- https://gjs.guide/extensions/upgrading/gnome-shell-47.html (accent color, -st-accent-color)
- https://gjs.guide/extensions/overview/anatomy.html#stylesheet-css
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.0/src/st/st-theme.c (`!important` via get_origin) , .../st-theme-context.c (get_accent_color)
