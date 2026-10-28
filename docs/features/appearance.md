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
