# Guava OS features

One page per area: what it does, how to use it, its settings with defaults, its limits and the main code. Every feature can be turned off in Guava OS's preferences. Defaults are read from `schemas/org.gnome.shell.extensions.guava-os.gschema.xml`; feature ids are in `features.js`.

| Area | Page | Registry ids |
|---|---|---|
| Menu bar, status items | [menu-bar.md](menu-bar.md) | `menu-bar`, `menu-bar-items`, `calendar`, `quick-settings-notifications`, `dnd-button` |
| App menus | [app-menus.md](app-menus.md) | `menu-bar` (via `core/appMenus`) |
| Window buttons (app titlebars) | [window-controls.md](window-controls.md) | `app-buttons`, `gtk-theme` |
| Tiling, Hide, full screen, Split View, Show Desktop | [windows.md](windows.md) | `window-tiling`, `app-hide`, `move-window-to-new-workspace`, `split-view`, `show-desktop` |
| Rounded corners | [rounded-corners.md](rounded-corners.md) | `rounded-corners` |
| Dock, Genie and Scale minimize | [dock.md](dock.md) | `dock`, `minimize-effect` |
| Stage Manager | [stage-manager.md](stage-manager.md) | `stage-manager` |
| Mission Control, Launchpad, app switcher, gestures, hot corners | [mission-control-launchpad.md](mission-control-launchpad.md) | `mission-control`, `launchpad`, `app-switcher`, `gestures`, `hot-corners`, `shell-behaviour` |
| Spotlight | [spotlight.md](spotlight.md) | `spotlight` |
| Clipboard history | [clipboard.md](clipboard.md) | `clipboard-history` |
| Control Center, Low Power Mode | [control-center.md](control-center.md) | `control-center`, `low-power` |
| Notification Center, Focus | [notification-center-focus.md](notification-center-focus.md) | `notification-center`, `focus` |
| Notch | [notch.md](notch.md) | `notch` |
| Desktop widgets | [widgets.md](widgets.md) | `desktop-widgets` |
| Desktop icons | [desktop-icons.md](desktop-icons.md) | `desktop-icons` |
| Screenshots | [screenshots.md](screenshots.md) | `screenshots` |
| Text cursor badges, Emoji & Symbols | [input.md](input.md) | `input-indicator`, `emoji-picker` |
| Volume pill, glass dialogs, colour filters | [system-ui.md](system-ui.md) | `osd`, `dialogs`, `color-filters` |
| Appearance | [appearance.md](appearance.md) | `appearance`, `popup-menu-styling` |
| Liquid Glass | [liquid-glass.md](liquid-glass.md) | `liquid-glass` |
| Setup Assistant | [onboarding.md](onboarding.md) | `onboarding` |

Related: [code map](../architecture/code-map.md), [how to write a feature](../architecture/conventions.md).

Owner decisions that apply to every feature:
- Features are on by default unless the macOS default is off (Stage Manager, hot corners, magnification, colour filters).
- This release supports GNOME 50 on Fedora 44 Workstation only. `lib/compat.js` already holds what GNOME 51 changes.
- Enable and disable are exact mirrors: everything a feature changes is put back.
