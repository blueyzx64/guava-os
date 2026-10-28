# Desktop widgets

## What it does
Widgets on the desktop, above the wallpaper and below windows. Registry id `desktop-widgets` (key `widgets`, on). The same widget model feeds the Notification Center and the notch's Widgets tab (`core/widgets/`). Code: `features/widgets/`.

## Use
- Right-click the desktop and choose **Edit Widgets** to open the gallery (also from the Notification Center). Add Default Widgets is offered when the desktop is empty; nothing is placed by default.
- Drag a widget to place it on a snapping grid (hold Ctrl for finer placement). Right-click for its size, options and Remove.
- Built-in kinds include time, calendar, weather, batteries, media and system widgets (`core/widgets/kinds/`).
- **Style (`widgets-style`, `automatic`):** automatic dims widgets to monochrome while a window is in front and shows full colour when the desktop is. Also `monochrome` and `full-color` choices.
- The layout is JSON in `widgets-layout`, per monitor.

## Limits
- Widget data runs only while widgets can be seen: not in the overview and not under a maximized or full-screen window. With no widget placed nothing runs.
- Guava's desktop icons flow around widgets ([desktop-icons.md](desktop-icons.md)).
