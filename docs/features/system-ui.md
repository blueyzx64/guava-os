# Volume pill, glass dialogs and colour filters

## Volume and brightness (`osd`)
`osd-location` chooses where changes show: `notch` (default, while the notch runs; otherwise the pill), `menu-bar` (a compact glass pill that drops under the Control Center button, as in macOS 26) or `system` (GNOME's centred pop-up). Volume, brightness and keyboard backlight are routed to one place; other OSDs and other monitors stay stock. The pill shows the output name and mute state and does not take clicks. Code: `core/osd.js`, `features/osd/`.

## Glass dialogs (`dialogs`, key `dialogs-glass`, on)
The Shell's modal dialogs (authentication, log out, restart, shut down, Run a Command, other extensions' dialogs) open as glass alerts: icon on top, buttons at the right, the default one in the accent colour. Theme only: the dialogs' logic is untouched. Each dialog is dressed when it opens and undressed when it closes or on disable. There is no preferences row; turn it off with `gsettings set org.gnome.shell.extensions.guava-os dialogs-glass false`. Code: `features/dialogs/`.

## Colour filters (`color-filters`, key `color-filter`, off)
Accessibility filters on the whole screen: greyscale, red/green (protanopia), green/red (deuteranopia) and blue/yellow (tritanopia) corrections, and a colour tint. Settings: `color-filter-kind` (`greyscale` default), `color-filter-intensity` 100, `color-filter-hue` 40 (for the tint). Found on the Appearance page. One shader effect on the Shell's UI group does the work, so changing the type or intensity only updates uniforms. Code: `features/colorFilters/`.

