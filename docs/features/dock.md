# Dock

## What it does
Guava's own dock on the bottom, left or right edge. Registry id `dock` (key `dock`, on). Pinned apps are your GNOME favourites. If the Dash to Dock extension is enabled, Guava turns it off while its dock runs and puts it back after.

## Use
- **Items:** pinned apps, running apps, up to three recent apps in their own section, minimized windows, the Downloads stack, folder Stacks and the Trash. Drag to pin, reorder or unpin.
- **Menus:** right-click an app for its actions, Options (Open at Login) and Show All Windows (App Exposé).
- **Indicators:** dots for open apps, grey dots for apps running in the background, badges and progress that apps publish (Unity LauncherEntry).
- **Stacks:** Downloads and your folders open as Fan, Grid, List or Automatic (`dock-downloads-view`).
- **Minimize:** Genie or Scale into the dock, or GNOME's effect ([below](#minimize-effects)). Reduce Motion makes windows fade.
- **Launchpad and Mission Control tiles:** `dock-launchpad` on, `dock-mission-control` off.

## Settings (default)
`dock` on · `dock-position` `bottom` · `dock-icon-size` 48 · `dock-magnification` off · `dock-magnification-size` 96 · `dock-autohide` off · `dock-autohide-delay` 500 ms · `dock-show-recents` on · `dock-running-dots` on · `dock-minimize-to-app` off (off: each minimized window gets its own tile) · `dock-minimize-effect` `genie` (`scale`, `gnome`) · `dock-launch-animation` on · `dock-attention-bounce` on · `dock-badges` on · `dock-background-apps` on · `dock-downloads` on · `dock-folders` empty · `dock-launchpad` on · `dock-mission-control` off.

## Minimize effects
Registry id `minimize-effect`, runs unless `dock-minimize-effect` is `gnome`. Genie and Scale play in reverse on restore. Under Reduce Motion the window fades; with animations off it goes at once. Stage Manager is a target too (windows fly to its strip). Windows another feature set aside, and windows with no target, get GNOME's effect.

## Limits
- The dock claims its edge through `core/layout.js`, so windows keep off it (none while it auto-hides); it hides over full screen and in the overview.

## Code
`features/dock/` (`index.js`, `view.js`, `items.js`, `magnify.js`, `stack.js`, `trash.js`, `appMenu.js`, `autostart.js`, `dashToDock.js`), `features/minimizeEffect/`, `lib/launcherEntry.js`, `lib/backgroundApps.js`.
