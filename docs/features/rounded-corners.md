# Rounded window corners

## What it does
Rounds the corners of app windows, including GTK 3, Qt and Electron windows. Registry id `rounded-corners` (key `rounded-corners`, on).

## Settings
`rounded-corners-which` `top` (top corners; `all` for four) · `rounded-corners-radius` 12 (0 to 24) · `rounded-corners-blacklist` empty (apps that keep square corners; WM_CLASS, its instance, GTK or sandbox app ids, ignoring case and `.desktop`).

## Rules
- Normal and dialog windows only. Maximized, tiled and full-screen windows, popups, menus, tooltips, desktop and dock windows and Shell windows are skipped.
- Corners an app already rounds at least as much (libadwaita) are left as drawn, so in `top` mode a libadwaita window keeps its rounded bottom.
- Shadows bend around the corner: pixels near the arc take the window's own edge colour at the same distance from the straight edges.

## Limits
- Each rounded window renders offscreen (one buffer per window); skipped windows paint directly. Full-screen games keep direct scanout.
- The shadow around the arc is an approximation of the straight-edge shadow.
- It uses a shader effect through `lib/compat.js`; on a GNOME version without that API it logs once and does nothing.

## Code
`features/roundedCorners/` (`index.js`, `effect.js`, `model.js`, `prefs.js`).
