# Pointer: shake to locate, hide while typing, size and colours

Like macOS Accessibility > Display > Pointer, plus AppKit's habit of hiding the pointer while
you type. Preferences: Appearance > Pointer. Registry id `pointer` (runs while any of its
settings is on). Code: `features/pointer/`.

## Shake mouse pointer to locate (`pointer-shake-to-locate`, on)
Shake the mouse, or move a finger quickly side to side on the touchpad, and the pointer grows to
about four times its size; it shrinks back shortly after you stop. A shake is three quick
reversals of side-to-side strokes of at least 50 px within 0.8 s (`model.js` `ShakeDetector`);
slow back-and-forth, small wiggles, a long straight move and vertical shaking do not count.

**Never while the pointer is busy.** While a mouse button is held, a compositor grab runs
(moving or resizing a window), the overview is open or a Shell modal is up (`isBlocked`), the
detector says no and drops its history; a big pointer already showing goes away. So dragging a
window can never make the pointer big, and motion from the drag cannot complete a shake after the
release. (This is the gate that was missing in Kiwi, where `_onMotion()` ignored `_blocked()`.)

**Crisp.** The big pointer is the theme's real large cursor, not the small sprite scaled up:
`theme.js` `loadCursorImage` reads the arrow from the Xcursor file at the smallest size that is
at least cursor-size x 4 x the largest monitor scale, and it is drawn from a `Clutter.Image` at
its own pixels (only ever shrunk a little). The tracker's sprite, scaled, is the fallback until
the image has loaded (a theme without that size). The real pointer is hidden while the big one
shows. Reduced motion: it jumps to the big size and back (`ctx.motion`).

## Hide pointer while typing (`pointer-hide-while-typing`, on)
The pointer hides when you type in a text field and comes back as soon as the mouse moves.
Typing is the text cursor moving twice with the pointer still (one move alone is a click that
placed the caret, or a focus change). It never hides while blocked, or after you switch windows.
The caret comes from `lib/caret.js` `onMoved`.

Limit: it needs an app that reports its text cursor (the same source as the text cursor badges:
GTK, Qt and most Wayland apps through IBus; apps that never report one keep the pointer).

## Pointer size (`pointer-size`, 'system')
System (GNOME's own size, untouched), Normal 24, Large 32, Larger 48, Largest 64, Huge 96. Guava
owns `org.gnome.desktop.interface cursor-size` while it is set and gives your own size back
when you pick System or Guava stops.

## Custom colours (`pointer-custom-colors`, off; `pointer-fill-color` '#000000', `pointer-outline-color` '#ffffff')
Pick the outline and fill colours; Reset puts back the macOS defaults. Guava makes a recoloured
copy of your cursor theme (dark parts take the fill, light parts the outline, the soft shadow
stays) in `~/.local/share/icons/Guava-Pointer-<colours>/` and selects it through `cursor-theme`
(given back when the option is off or Guava stops). A change of colour makes a new folder and
removes Guava's older ones; turning the option off removes them all. Only folders with Guava's
`.guava-pointer` marker are ever touched.

Limit: only Xcursor themes are recoloured (Adwaita and most themes are). Apps that draw their own
cursor images keep theirs.

## Tests
`tests/pointerModel.test.js` (shake, the blocked gate and its reset, typing, config, Xcursor);
real Shell: `tools/scenarios/pointer-shake.sh` (shake shows, a window drag never does,
disable restores size and theme).
