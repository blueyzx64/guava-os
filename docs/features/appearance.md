# Appearance

## What it does
Light and Dark, accent and highlight colours, icon style, menu styling and GTK app fixes. Registry ids `appearance`, `popup-menu-styling`, `gtk-theme`. Code: `features/appearance/`, `features/appButtons/gtkTheme.js`. Liquid Glass has its own page: [liquid-glass.md](liquid-glass.md).

## Use
- **Auto Light and Dark (`appearance-auto`, off):** Light by day, Dark by night, by sunset and sunrise (`appearance-auto-schedule` `sun`, from the location Night Light last saw, else your time zone) or custom times (`appearance-auto-light-minute` 420, `appearance-auto-dark-minute` 1140). It switches only once you have been idle for a minute. Choosing a style yourself turns Auto off. Guava owns GNOME's `color-scheme` only while Auto runs (restored after, also after a crash).
- **Accent colour (`appearance-accent`, `multicolor`):** Multicolor follows GNOME's accent and writes nothing; a colour sets GNOME's accent while Guava runs. Blue, Purple, Pink, Red, Orange, Yellow, Green, Graphite.
- **Highlight colour (`appearance-highlight`, `accent`):** text selection in Spotlight and the clipboard fields.
- **Icon style (`appearance-icon-style`, `default`):** Default, Dark, Clear or Tinted app icons in the dock and Spotlight.
- **Menus (`popup-menu-styling`, on):** accent styling for GNOME's popup menus and the matching GTK app fixes.
- **GTK titlebars (`gtk-theme`, always runs):** writes Guava's imports to `~/.config/gtk-3.0/gtk.css` and `gtk-4.0/gtk.css` between two marker comments (traffic lights for app windows, hidden titlebar buttons, app fixes). The rest of your file is never touched; a file that held only Guava's block is deleted on disable. If Guava was removed without being disabled, delete the block between the two "Guava OS - managed imports" comments.

## Colour filters
See [system-ui.md](system-ui.md).

## Typography
Registry id `typography` (always runs). Code: `features/typography/`. Scenario: `tools/scenarios/typography-smoothing.sh`.
- **macOS text rendering (`macos-text-rendering`, on):** owns `org.gnome.desktop.interface` `font-rendering` `manual`, `font-hinting` and `font-antialiasing` `grayscale`. With GNOME 50's default `automatic`, GTK4 and libadwaita apps ignore the hinting key (verified by pixels in the harness: same output for none and full under `automatic`, different under `manual`), so Guava owns `manual` too. Your values come back when it goes off, when Guava stops, or when you change a key yourself (the part turns off).
- **Font smoothing (`macos-font-smoothing`, on):** heavier text through FreeType stem darkening. Guava writes `~/.config/environment.d/60-guava-freetype.conf` (first line `# Managed by Guava OS`, one `FREETYPE_PROPERTIES=` line, the values of macos-font-rendering's setup.sh). It applies to every app and the Shell from the next login. While it is on, `font-hinting` is `slight` instead of `none`: darkening reaches TrueType fonts (Inter, Noto) only under light hinting, CFF fonts darken at any hinting.
  - Measured in the harness (Noto Sans 14, grayscale): ink x1.30 in a GTK3 and in a GTK4 app; slight hinting alone x0.98, so the variable does the work.
  - The file follows the key, not enable/disable (GNOME disables extensions at every lock). On: written when missing or changed. Off: removed. A file without Guava's first line, and a symlink, are never written or removed. Async, through the shared user-file queue.
  - If Guava is uninstalled while the key is on, the file stays: delete `60-guava-freetype.conf` by hand.
- **macOS font (`macos-font`, on):** SF Pro, else Inter, at your size for `font-name` and `document-font-name`; SF Mono for `monospace-font-name`. Families come from `fc-list` in a subprocess; font folders are watched.
