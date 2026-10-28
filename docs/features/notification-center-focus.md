# Notification Center and Focus

## Notification Center (`notification-center`, on)
Clicking the clock opens a glass column at the right: the date and a small month, your notifications grouped by app, and a widgets area (`notification-center-widgets`, on). Groups stack, expand, and clear with Clear / Clear All; notifications keep their actions. With the feature off the clock opens GNOME's calendar card. While the column is open new banners are held and land in the list instead. "Edit Widgets" opens the desktop widgets gallery ([widgets.md](widgets.md)). Code: `features/notificationCenter/`, history from `core/notificationRouter.js`.

## Calendar and notifications in the top bar (`calendar`)
The date menu sits at the right end of the bar as a calendar card (`move-calendar-right`, on; forced on while the notch runs). Its notification list moves into Quick Settings unless `keep-notification-panel` (off) is on. `custom-dnd-button` (on) is Guava's Do Not Disturb moon button; the Control Center's own tile wins when both exist. `notification-indicator-style` (`default`, `accent`, `symbolic`) sets the dot that shows waiting notifications. Code: `features/calendar/`.

## Focus (`focus`, key `focus-modes`, on)
Modes over GNOME's Do Not Disturb: Do Not Disturb, Sleep, Work, Personal and your own. A mode names the apps allowed to notify, optional schedules (for example 22:00-07:00) and apps that turn it on while they are open. Banners from other apps are held back but stay in the Notification Center. Time-sensitive (urgent) notifications break through. The Control Center's Focus tile has the mode menu ("for 1 hour" and so on) and the menu bar can show the active mode's icon (`focus-menubar-icon`, on). GNOME's Do Not Disturb follows the "Do Not Disturb" mode both ways, so the stock toggle and Alt-click on the clock agree.

Settings: `focus-modes` on · `focus-profiles` (modes, internal JSON) · `focus-menubar-icon` on. Nothing polls: one timer is armed for the next schedule edge. Code: `features/focus/`.
