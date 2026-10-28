# Control Center, menu bar items and Low Power Mode

## What it does
Re-lays out GNOME's Quick Settings menu like the macOS Control Center. Nothing GNOME builds is replaced: the stock items are reordered into blocks (connectivity, focus, display, sound, media, toggles, footer) and restyled, so every toggle keeps GNOME's own logic. Registry id `control-center` (key `control-center`, on). Code: `features/controlCenter/`.

## Use
- **Blocks:** Wi-Fi, Bluetooth and other connectivity; Focus; Display and Sound sliders; Now Playing; small icon toggles (Dark Mode, Night Shift, Airplane Mode...); a Guava module with a tile per Guava feature; a user row (picture, name, battery time left) with Settings, Lock and Power.
- **Edit Controls:** at the bottom of the menu. Pick, order and size controls from a gallery of GNOME's items, Guava feature switches, accessibility switches (Text Size, Increase Contrast, Reduce Motion, VoiceOver, Accessibility Keyboard, Sticky Keys, Flash Screen for Alerts) and Guava actions (Screenshot, Screen Recording, Timer, Keep Awake, Low Power Mode). The arrangement is `control-center-layout`; empty means the default. Reset is in preferences.
- **Items from other extensions** stay, under a "More" heading.
- **Pin to the menu bar:** a control can also get its own menu bar item (Always, When Active, Never); see [menu-bar.md](menu-bar.md).
- **Timer:** Guava's own countdown timers (`core/timers.js`); they survive the lock screen and show in the notch.

## Low Power Mode (`low-power`)
`low-power-battery` and `low-power-adapter` (both off) hold power-profiles-daemon's power-saver profile while that power source is in use. Choosing a profile by hand in GNOME drops the hold until the source or the choice changes. Without the daemon it is unavailable and holds nothing. It also provides battery health (capacity, charge cycles) for the Battery menu bar item. Code: `features/lowPower/`.

## Settings (default)
`control-center` on · `control-center-user-row` on · `battery-percentage-always` off · `control-center-layout` empty · `menubar-pinned` empty · `menubar-battery-percentage` off.

## Limits
- Removed stock items are hidden, never destroyed. Turning the feature off restores the stock order, spans and column count from a snapshot.
- While Focus runs, its tile takes Do Not Disturb's place ([notification-center-focus.md](notification-center-focus.md)).
