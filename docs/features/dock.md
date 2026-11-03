# Dock

## What it does
Guava's own dock on the bottom, left or right edge. Registry id `dock` (key `dock`, on). Pinned apps are your GNOME favourites. If the Dash to Dock extension is enabled, Guava turns it off while its dock runs and puts it back after.

## Use
- **Items:** pinned apps, running apps, up to three recent apps in their own section, minimized windows, the Downloads stack, folder Stacks and the Trash. Drag to pin, reorder or unpin.
- **Menus:** right-click an app for its actions, Options (Open at Login) and Show All Windows (App Exposé).
- **Indicators:** dots for open apps, grey dots for apps running in the background, badges and progress that apps publish (Unity LauncherEntry).
- **Stacks:** Downloads and your folders open as Fan, Grid, List or Automatic (`dock-downloads-view`).
- **Minimize:** Genie or Scale into the dock, or GNOME's effect ([below](#minimize-effects)). Reduce Motion makes windows fade.
- **Magnification:** `dock-magnification` (off by default) grows the icons near the pointer up to `dock-magnification-size`. Icons are drawn at that size once and shown smaller, so a magnified icon is a sharp bitmap, not a small one stretched (B18); turning magnification off draws them at plain size again. While the Shell misses its frame budget (`ctx.motion.env.degraded`) magnification stays off and returns when the load clears (B28).
- **Launchpad and Mission Control tiles:** `dock-launchpad` on, `dock-mission-control` off.

## Settings (default)
`dock` on · `dock-position` `bottom` · `dock-icon-size` 48 · `dock-magnification` off · `dock-magnification-size` 96 · `dock-autohide` off · `dock-autohide-delay` 500 ms · `dock-show-recents` on · `dock-running-dots` on · `dock-minimize-to-app` off (off: each minimized window gets its own tile) · `dock-minimize-effect` `genie` (`scale`, `gnome`) · `dock-launch-animation` on · `dock-attention-bounce` on · `dock-badges` on · `dock-background-apps` on · `dock-downloads` on · `dock-folders` empty · `dock-launchpad` on · `dock-mission-control` off.

## Minimize effects
Registry id `minimize-effect`, runs unless `dock-minimize-effect` is `gnome`. Genie and Scale play in reverse on restore. Under Reduce Motion the window fades; While the Shell misses its frame budget (`ctx.motion.env.degraded`) the Genie plays as Scale (B28). Under Reduce Motion the window fades; with animations off it goes at once. With no dock icon (dock hidden, off or still starting) the window goes to the middle of the dock's edge of its monitor, so maximized, full-screen and other-monitor windows get the effect too. Restoring during a minimize (or the reverse) turns the effect back from where it is, in the time left. In the overview the window goes at once, as in GNOME. Windows another feature set aside (Hide) get GNOME's effect. Stage Manager does not intercept a minimize: the window goes to the Dock like any other. The funnel is drawn from a texture at the monitor's scale, mapped texel to pixel.

## Limits
- **Dash to Dock hand-off:** Dash to Dock sits before Guava in the Shell's extension order when it was enabled first. Taking it out of `enabled-extensions` would make the Shell re-base Guava (disable, then enable: a second full start at login, measured in the harness as three `enable`/`disable` calls instead of one). Guava steps out of the Shell's order list for the write and returns when the dock is out (`dashToDock.js`, `rebaseShield` in `model.js`); `tools/scenarios/dock-dashtodock.sh` checks it (B22).
- The Mission Control tile is drawn from CSS shapes, not a bitmap, so it is not re-rendered for magnification.
- The dock claims its edge through `core/layout.js`, so windows keep off it (none while it auto-hides); it hides over full screen and in the overview.

## Code
`features/dock/` (`index.js`, `view.js`, `items.js`, `magnify.js`, `stack.js`, `trash.js`, `appMenu.js`, `autostart.js`, `dashToDock.js`), `features/minimizeEffect/`, `lib/launcherEntry.js`, `lib/backgroundApps.js`.
