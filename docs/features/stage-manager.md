# Stage Manager

## What it does
The focused app's windows sit at the centre (the stage). Other apps wait as live, tilted previews in a strip at the screen edge; click one to swap it onto the stage. Registry ids `stage-manager` (key `stage-manager`, **off by default**) and `stage-manager-shortcut`.

## Use
- **Switch:** click a strip entry. Opening an app puts it on the stage alone and the old set waits in the strip as one entry (or joins the set, see New windows).
- **Sets:** drag an entry onto the stage, or Shift-click it, to use it with the windows already there. Drop on the left or right part for two windows side by side; the middle adds it as is. A set shows as one stacked entry. Take a window out by dragging its title bar onto the strip, or with Ctrl+Super+Down.
- **Wallpaper click:** moves the stage into the strip to show the desktop; click again to bring it back.
- **Per Space:** each workspace has its own strip, which slides on a Space switch and hides in Mission Control.
- **Keyboard:** Super+Alt+Page Down / Page Up for the next / previous set, Super+Alt+1 to 6 for strip entries. Toggle shortcut is empty by default (preferences offers Ctrl+Super+S).
- Minimize sends a window to the strip. Show Desktop moves the stage into the strip.

## Settings (default)
`stage-manager` off · `stage-manager-side` `left` (`right`) · `stage-manager-show-recent` on (off: the strip appears only when the pointer pushes the edge) · `stage-manager-autohide` on (the strip steps aside under overlapping windows) · `stage-manager-group-by-app` on (all of an app's windows at once; off: one entry per window; changing it restarts the feature) · `stage-manager-new-windows` `replace` (`join`) · `stage-manager-wallpaper-click` on · `stage-manager-tilt` 22 degrees · `stage-manager-animation-speed` 1.0 · shortcuts `stage-manager-shortcut`, `-remove-`, `-next-`, `-previous-`, `-slot-1..6-shortcut`.

## Limits
- While it runs, full screen in its own Space is paused (the saved value is kept) and Stage Manager owns window placement.
- Side by side uses `move_resize_frame` (Mutter has no public tiling API). A set of more than two windows gets equal columns; an app whose minimum width is larger keeps it, and windows are then spread evenly inside the stage.
- Sets live in memory per workspace for the session.
- Windows out of the stage are hidden by opacity and picking, not minimized, so apps keep running normally. Turning it off puts every window back.

## Code
`features/stageManager/` (`model.js` StageMachine, `geometry.js`, `index.js`, `view.js`, `flights.js`, `windows.js`, `shortcut.js`); strip claimed through `core/layout.js` (opposite a side dock); `core/windowState.js`.
