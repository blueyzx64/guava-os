# Mission Control, Launchpad, app switcher, gestures, hot corners

## Mission Control and App Exposé (`mission-control`, on)
GNOME's overview restyled: a Spaces bar on top, the current Space's windows spread out, no search and no dash.
- **Open:** F3, Ctrl+Up (`mission-control-shortcut`; also the XF86LaunchA key), a three- or four-finger swipe up, the optional dock tile, a hot corner.
- **App Exposé:** Ctrl+Down (`app-expose-shortcut`), the dock's Show All Windows, a four-finger swipe down. Shows one app's windows with its minimized ones in a strip at the bottom.
- **Spaces bar:** add with +, remove with x, drag to reorder.
- **Settings (default):** `mc-static-spaces` on (Spaces stay until you remove them; GNOME's dynamic workspaces are off meanwhile) · `mc-rearrange-spaces` off · `mc-group-by-app` off · `mc-switch-to-app-space` on · `mc-start-on-desktop` on (the desktop, not the overview, after login).
- The dock and the Stage Manager strip hide while it is open. Code: `features/missionControl/`.

## Launchpad (`launchpad`, on)
A full-screen grid of every app with pages, search, folders (drag an app onto another), drag to reorder and keyboard navigation. Open from the dock tile, Super+A or F4 (`launchpad-shortcut`), or a pinch. While it runs it takes Super+A from GNOME's app grid and gives it back after. GNOME's app folders and order are its data, so GNOME's grid stays in step.
- **Jiggle mode:** hold Alt or press and hold an icon. An x shows on Flatpak apps only (removed through GNOME Software, `launchpad-delete-apps` on).
- Code: `features/launchpad/`.

## App switcher (`app-switcher`, on)
Super+Tab opens a panel of big app icons, most recently used first. Tab, Shift+Tab, ` and the arrows move; Q quits and H hides the selected app; Down, Up or 1 shows its windows (App Exposé); Esc cancels; releasing Super activates. Super+` cycles the front app's windows without a panel (`switcher-cycle-windows`, on). `switcher-switch-to-space` (on) goes to a Space where the app has windows; `switcher-restore-minimized` (off) restores minimized windows (hold Alt on release to do it once). Alt+Tab opens it too (Fedora binds `switch-applications` to Super+Tab and Alt+Tab). Guava sets handlers for `switch-applications` and `switch-group` and never writes your shortcuts. Code: `features/switcher/`.

## Gestures (`gestures`, on)
Three- or four-finger swipe up: Mission Control; left or right: switch Spaces (GNOME's own swipes); four-finger swipe down: App Exposé; pinch with thumb and three fingers: Launchpad; spread: Show Desktop. Each has its own key (`gestures-*`). Swiping up stops at the window picker and never goes on into the app grid (`overview-gestures-workspace-only`, on). Opening the Notification Center from a two-finger edge swipe is not possible (the Shell gets only three-finger and larger gestures). Code: `features/gestures/`, `features/shellBehaviour/`.

## Hot corners (`hot-corners`)
Each corner can run Mission Control, Application Windows, Desktop, Notification Center, Launchpad, Lock Screen or Put Display to Sleep, optionally only while Shift, Ctrl, Alt or Super is held. All four are off by default (`hot-corner-<corner>` = `none`) and the feature does not run then. GNOME's own top-left hot corner is off (`disable-hot-corner`, on). Code: `features/hotCorners/`, actions in `core/desktopActions.js`.
