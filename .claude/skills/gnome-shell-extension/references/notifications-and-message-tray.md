# Notifications, MessageTray, banners and DND

Summary: how notifications flow (app → daemon → `Source` → `Main.messageTray` → banner and calendar list) and the 46+ property-bag API for `Source` and `Notification`.
It also covers how to post your own notifications, and how to intercept or suppress banners to render them in a panel "notch".
Verified against `js/ui/messageTray.js`, `messageList.js`, `notificationDaemon.js`, `dateMenu.js`, `panel.js` and `main.js` on gnome-shell main (51), plus tags 45.0 and 46.0.

## Contents
1. Data flow
2. API (46+) and the 45 difference
3. Posting notifications
4. Policy, urgency, DND and fullscreen
5. Intercepting and suppressing banners (notch design)
6. Calendar message list and counts
7. Pitfalls
8. Sources

## 1. Data flow
1. A client sends a notification. FDO D-Bus clients go to
   `FdoNotificationDaemonSource`, GTK/portal clients to
   `GtkNotificationDaemonAppSource` (notificationDaemon.js). Each source gets a
   `NotificationApplicationPolicy` (backed by GSettings) and is registered with
   `Main.messageTray.add(source)`.
2. `MessageTray.add(source)` calls `policy.store()`. If `policy.enable` is set,
   it calls `_addSource`, which connects `notification-request-banner`,
   `notification-removed` and `destroy`, and emits **`source-added`**.
3. `source.addNotification(n)` keeps at most 10 per source, emits
   **`notification-added`** and then **`notification-request-banner`**.
4. `MessageTray._onNotificationRequestBanner` drops the banner if the
   notification is `acknowledged`, if its urgency is `LOW`, or if
   `!source.policy.showBanners && urgency !== CRITICAL`. Otherwise it queues
   it: the queue holds at most 3 and is sorted by urgency.
5. `_updateState()` shows the next banner unless `bannerBlocked` is set or
   there is no monitor. If the user is busy (DND/presence) or the primary
   monitor is fullscreen, only `forFeedback` or `CRITICAL` notifications are
   shown. `_showNotification()` builds `new MessageList.NotificationMessage(n)`
   into `this._bannerBin` (chrome tracked with `trackChrome`) and sets
   `n.acknowledged = true` when it is shown.
6. Independently, `MessageList.MessageView` (the calendar drop-down) listens to
   `Main.messageTray` `source-added` and lists every notification, grouped per
   app since 48. `dateMenu.js` `MessagesIndicator` (the dot next to the clock)
   counts unseen notifications minus `Main.messageTray.queueCount`.

## 2. API (46+)
```js
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const source = new MessageTray.Source({
    title: 'Guava', iconName: 'edit-paste-symbolic',
    policy: new MessageTray.NotificationGenericPolicy(), // the default when omitted
});
Main.messageTray.add(source);

const n = new MessageTray.Notification({
    source, title: 'Copied', body: 'Text added to clipboard history',
    urgency: MessageTray.Urgency.LOW,   // LOW | NORMAL | HIGH | CRITICAL
    isTransient: true,                   // removed from the list after the banner
    // also: gicon, iconName, useBodyMarkup, sound, datetime, privacyScope,
    //       resident, forFeedback, acknowledged
});
n.addAction('Undo', () => {});
n.connect('activated', () => {});
source.addNotification(n);
// disable(): source.destroy();  // destroys its notifications; MessageTray drops the source
```
- `MessageTray.getSystemSource()` returns the shared "System" source (46+).
  `Main.notify(title, body)` and `Main.notifyError()` use it.
- Notification signals: `activated`, `destroy(reason)`, `action-added`,
  `action-removed`, `notify::acknowledged`. Source signals: `destroy`,
  `notification-added`, `notification-removed`, `notification-request-banner`.
  MessageTray signals: `source-added`, `source-removed`, `queue-changed`.
- `NotificationDestroyedReason`: `EXPIRED`, `DISMISSED`, `SOURCE_CLOSED`,
  `REPLACED`.
- **GNOME 45 differs:** `new Notification(source, title, banner, params)`,
  `notification.setTransient(true)`, `setUrgency()`, `source.showNotification(n)`,
  and `new Source(title, iconName)` (messageTray.js 45.0). Guava (48+) never
  needs this form. Don't copy 45-era snippets.

## 3. Posting notifications
- Use them sparingly. Guava removes window-ready notifications
  (`(Kiwi: apps/focusLaunchedWindow.js; Guava equivalent not verified)`), so don't add new noise.
- Create the source lazily at first use, not at import. Destroy it in
  `disable()`.

## 4. Policy, urgency, DND and fullscreen
- DND is the GSettings key `org.gnome.desktop.notifications show-banners`
  (false = DND on). From GNOME 49 the toggle is a Quick Settings tile
  (`status/doNotDisturb.js`) that binds that key with `INVERT_BOOLEAN`.
  `MessageTray` also tracks `_busy` from GNOME presence status.
- Per-app settings: `org.gnome.desktop.notifications.application` (relocatable),
  read through `NotificationApplicationPolicy` (`enable`, `enableSound`,
  `showBanners`, `forceExpanded`, `showInLockScreen`, `detailsInLockScreen`).
- Fullscreen: the primary monitor's `inFullscreen` suppresses non-critical
  banners.

## 5. Intercepting and suppressing banners (notch design)
Goal: no stock banner sliding down. Instead, a compact pill in the panel
centre expands to show the notification.

Option A (recommended): divert the queue head into your own UI.
`MessageTray._updateState()` calls `this._showNotification()` dynamically, after
the stock filters have run (acknowledged, LOW, `showBanners`/DND, busy,
fullscreen, `hasNotifications`, `bannerBlocked`). Overriding it therefore
catches every source, including ones added before `enable()`:
```js
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
// enable()
this._inj = new InjectionManager();
const notch = this._notch;                       // your actor/controller
this._inj.overrideMethod(MessageTray.MessageTray.prototype, '_showNotification',
    orig => function () {
        if (!notch?.active)
            return orig.call(this);
        const n = this._notificationQueue.shift(); // same as stock
        this.emit('queue-changed');
        n.acknowledged = true;                     // stock banner does this; keeps the unseen count right
        notch.present(n);                          // render with MessageList.NotificationMessage
    });
// disable(): this._inj.clear(); this._inj = null; notch.destroy();
```
- The tray state stays `HIDDEN`, so the next queued notification is diverted
  on the next `_updateState()`. Call `Main.messageTray._updateState()` after
  the notch finishes if items are still queued (private API).
- Don't override `_onNotificationRequestBanner` for this. `_addSource()`
  connects it with `.bind(this)` at connect time, so sources that already
  exist keep the original handler.
- To observe without suppressing, connect `Main.messageTray` `source-added`
  (plus `getSources()` for existing ones), then each source's
  `notification-added` and `notification-request-banner`. Use
  `connectObject(..., owner)` and `disconnectObject(owner)` in `disable()`.
- Setting `acknowledged = false` re-requests a banner. `notification-added`
  fires before `notification-request-banner`.
- Option B: `Main.messageTray.bannerBlocked = true`. This is public-ish, but
  `Panel._onMenuSet` rewrites it whenever a panel menu aligned with the banner
  opens or closes, so it can't be relied on alone.
- Option C: move or restyle the stock banner. Change
  `Main.messageTray.bannerAlignment` (`Clutter.ActorAlign`) or restyle
  `.notification-banner`. "Hide Top Bar" also patches
  `Main.messageTray._bannerBin.ease` to shift the y position when the panel is
  hidden.
- Building the notch content: `new MessageList.NotificationMessage(n)` renders
  a notification exactly like the banner (title, body, icon, actions) and
  binds to its properties. Put it in your own container in the
  `Main.panel._centerBox` area, or in `Main.layoutManager.addTopChrome(actor)`
  for an overlay that can grow below the panel.
- Clicking: `n.activate()` emits `activated`, which focuses the app.
  Dismissing: `n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED)`.

## 6. Calendar message list and counts
- Guava's `features/calendar/index.js` and `(Kiwi: apps/quickSettingsNotifications.js; Guava equivalent not verified)` already
  move or embed the list. Check them before adding a second consumer.
- `Main.panel.statusArea.dateMenu._messageList` (CalendarMessageList) and
  `._indicator` (MessagesIndicator) are private.
- Media (MPRIS) players appear as `MediaMessage` in the list via
  `Mpris.MprisSource`. Since 49.1 they follow notification policy.

## 7. Pitfalls
- Don't keep references to notifications after their `destroy` signal.
- Sources whose `policy.enable` is false never reach `source-added`. Listen to
  `policy` `notify::enable` if you need them.
- On the lock screen (`unlock-dialog` mode) extensions are disabled unless
  declared. Banners there are handled by `screenShield`/`notificationsBox`.
- Overriding `_showNotification` and touching `_notificationQueue` is private
  API. Re-check it on every release. The code shape is the same at 46.0 and
  main (51).

## 8. Sources
- https://gjs.guide/extensions/topics/notifications.html
- https://gjs.guide/extensions/upgrading/gnome-shell-46.html
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/messageTray.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/messageList.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/notificationDaemon.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dateMenu.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/45.0/js/ui/messageTray.js (old API)
- https://github.com/mlutfy/hidetopbar (panelVisibilityManager.js banner shift)
