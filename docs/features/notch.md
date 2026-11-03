# Notch

## What it does
A black pill hanging from the top centre of the bar. It grows to show notifications, live activities and volume changes, and opens into three tabs: **Now** (media, activities, clock), **Tray** (a file shelf) and **Widgets**. Registry id `notch` (key `notch`, on). Code: `features/notch/`.

## Use
- **Open:** rest the pointer on it (`notch-hover-expand`, on, delay `notch-hover-delay` 300 ms) or click. A hover-opened notch closes 0.6 s after the pointer leaves; a clicked one stays 2.5 s after it leaves. Click outside or press Esc to close at once.
- **Notifications:** banners show in the notch instead of GNOME's (`notch-notifications`, on) for `notch-timeout` 5 seconds (hovering keeps them; urgent ones stay). Do Not Disturb silences them; Focus filters them ([notification-center-focus.md](notification-center-focus.md)). History stays in the Notification Center.
- **Live activities** (`notch-live-activities`, on): the most important one takes the pill, the rest list in Now. Media (art, title, controls), charging and low battery (`notch-activity-battery`), Bluetooth headphones (`-bluetooth`), Guava timers (`-timers`), screen recording with a stop button (`-recording`), next calendar event from 15 minutes before (`-calendar`), downloads (`-downloads`). All on. A download goes when the app that sent its progress leaves the bus, or when nothing has moved for 5 minutes (a cancelled download, a `.part` left behind by an interrupted one; an old one found at login never shows).
- **One-time codes:** a Copy button for codes found in notifications (`notch-copy-codes`, on); read only on this computer.
- **Tray (file shelf):** links to files; finished downloads (`notch-shelf-downloads`) and screenshots (`notch-shelf-screenshots`) are added, or use Add from Clipboard. The files themselves are not copied. `notch-show-clipboard` (off) lists clipboard text in the Tray.
- **Volume and brightness** show here while `osd-location` is `notch` ([system-ui.md](system-ui.md)).

## The file shelf helper
Dragging files out of the shelf into other apps needs the optional `guava-shelf-helper` RPM (a Wayland client must start the drag). Without it the shelf keeps its Open and Copy actions.

Drop targets under the notch: a maximized window, or one touching the top bar, reaches right under the dashboard (the card spans y 0-192). The helper window itself is fine for them (always-above, sticky, placed at the shelf's own y, well inside the work area, so mutter never moves it). The bug was Guava's own input plate, a reactive layer over the dashboard that stands in for the island while the helper window is under the shelf: it kept the pointer during a drag, so a drop anywhere inside the dashboard's footprint never reached the window below. Floating windows seemed fine only because users dropped them below the card. `view.js` now takes the plate away for the length of the drag (`_syncPlate`).

## Limits
- While the notch runs, the clock and calendar are at the right and the notification list is in Quick Settings.
- It takes the centre of the top bar through `core/panelLayout.js`. It stacks just above the bar, below modal dialogs, the on-screen keyboard and the screenshot UI (an open dashboard goes on top while open).
- Over a full-screen window it shows only something transient; when the bar slides in, the notch slides in with it (as a part of the bar: the pointer goes through it, so the bar slides away when the pointer leaves).

## Code
`stateMachine.js`, `model.js` and `downloadsModel.js` (download expiry) are pure; `view.js`, `pills.js`, `tabs.js`, `ui.js` draw; `sources/` feeds activities; `shelf.js`, `drop.js`, `shelfHelper.js` run the shelf.
