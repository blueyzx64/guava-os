# Panel buttons and Quick Settings (Control Center)

Summary: how to add a top-bar button (`PanelMenu.Button` + `Main.panel.addToStatusArea`) and how to add Quick Settings items (`SystemIndicator`, `QuickToggle`, `QuickMenuToggle`, `QuickSlider`).
It also covers ordering inside the grid and hiding or replacing built-in items. That is the basis for a macOS-style Control Center.
Verified against `js/ui/panel.js`, `js/ui/panelMenu.js`, `js/ui/quickSettings.js` and `js/ui/status/*.js` on gnome-shell main (51) and 48.0.

## Contents
1. Panel structure
2. PanelMenu.Button and addToStatusArea
3. Quick Settings architecture
4. QuickToggle / QuickMenuToggle / QuickSlider recipes
5. Ordering, column span, replacing built-ins
6. A Control Center from scratch (custom menu)
7. Pitfalls by version
8. Sources

## 1. Panel structure
- `Main.panel` (an `St.Widget`) holds `_leftBox`, `_centerBox` and `_rightBox`.
  These are private but stable for years.
- `Main.panel.statusArea[role]` holds the built-ins: `activities`,
  `quickSettings`, `dateMenu`, `a11y`, `keyboard`, `dwellClick`,
  `screenRecording`, `screenSharing` (`PANEL_ITEM_IMPLEMENTATIONS`). Each
  indicator's actor in the box is `indicator.container`.
- `Main.layoutManager.panelBox` (vertical `St.BoxLayout`) contains `Main.panel`.
  It is chrome with `affectsStruts: true, trackFullscreen: true`. See
  `layout-chrome-and-panel-hiding.md`.

## 2. PanelMenu.Button and addToStatusArea
```js
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ClipboardButton = GObject.registerClass(
class ClipboardButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Guava Clipboard');      // menuAlignment, nameText, dontCreateMenu
        this.add_child(new St.Icon({icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon'}));
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Clear'));
    }
});
// enable():
this._button = new ClipboardButton();
Main.panel.addToStatusArea('guava-clipboard', this._button, 1, 'right'); // role, position, box
// disable():
this._button.destroy(); this._button = null;    // removes it from statusArea via its 'destroy' handler
```
- `addToStatusArea` throws if the role already exists ("Extension point
  conflict"). It also throws if the indicator is not a `PanelMenu.Button`. The
  box is `'left' | 'center' | 'right'` (right by default) and the position
  defaults to 0.
- Pass `dontCreateMenu = true` for a button with no menu, such as a
  window-controls cluster. Handle clicks with `vfunc_event` or
  `connect('button-press-event')` (in 49+ consider Clutter gestures).
- The panel adds the menu to `Main.panel.menuManager`. While a menu whose box
  alignment matches `Main.messageTray.bannerAlignment` is open, it sets
  `Main.messageTray.bannerBlocked = isOpen`.
- **Center box for the notification "notch":** `addToStatusArea(role, btn, 0, 'center')`.
  The date menu also lives in `_centerBox` by default. Guava's `features/calendar/index.js`
  moves it to the right, so coordinate with that module.

## 3. Quick Settings architecture
- `Main.panel.statusArea.quickSettings` is a `PanelMenu.Button`.
  - `_indicators`: the `St.BoxLayout` of panel icons.
  - `menu`: a `QuickSettingsMenu` with `_grid` (`QuickSettingsLayout`,
    2 columns, `N_QUICK_SETTINGS_COLUMNS = 2`).
- `_setupIndicators()` is **async**. Built-ins such as `_network`,
  `_bluetooth`, `_system`, `_volumeOutput`, `_brightness`, `_doNotDisturb` (49+),
  `_darkMode`, `_nightLight`, `_powerProfiles` and `_backgroundApps` may not
  exist yet when your `enable()` runs at startup.
- `SystemIndicator` (St.BoxLayout) has `quickSettingsItems[]` and
  `_addIndicator()` (returns an `St.Icon` that controls its own visibility).
- `addExternalIndicator(indicator, colSpan = 1)` (45+) inserts the panel icon
  before `_brightness` and the items before the background-apps item.

## 4. Recipes
```js
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickToggle, QuickMenuToggle, QuickSlider, SystemIndicator}
    from 'resource:///org/gnome/shell/ui/quickSettings.js';

const WifiLikeToggle = GObject.registerClass(
class WifiLikeToggle extends QuickMenuToggle {
    _init(settings) {
        super._init({title: 'Focus', subtitle: 'Off', iconName: 'weather-clear-night-symbolic',
            toggleMode: true});                 // toggleMode: clicking flips `checked`
        settings.bind('focus-mode', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this.menu.setHeader('weather-clear-night-symbolic', 'Focus', 'Silence notifications');
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Work'));
    }
});

const VolumeLikeSlider = GObject.registerClass(
class VolumeLikeSlider extends QuickSlider {
    _init() {
        super._init({iconName: 'display-brightness-symbolic', iconReactive: true});
        this.slider.connect('notify::value', () => { /* 0..1 by default */ });
        this.connect('icon-clicked', () => {});
        this.slider.accessible_name = 'Glass intensity';
    }
});

const GuavaIndicator = GObject.registerClass(
class GuavaIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        this._icon = this._addIndicator();
        this._icon.icon_name = 'weather-clear-night-symbolic';
        const toggle = new WifiLikeToggle(settings);
        toggle.bind_property('checked', this._icon, 'visible', GObject.BindingFlags.SYNC_CREATE);
        this.quickSettingsItems.push(toggle, new VolumeLikeSlider());
    }
    destroy() {                                  // items are not children of the indicator
        this.quickSettingsItems.forEach(i => i.destroy());
        super.destroy();
    }
});
// enable(): Main.panel.statusArea.quickSettings.addExternalIndicator(this._ind = new GuavaIndicator(s));
// disable(): this._ind.destroy(); this._ind = null;
```
Properties (quickSettings.js main):
- `QuickToggle`: `title`, `subtitle`, `icon-name`, `gicon`, plus St.Button's
  `checked` and `toggle-mode`.
- `QuickMenuToggle`: the same plus `menu-enabled` and
  `menu-button-accessible-name`, and always has `.menu`.
- `QuickSlider`: `icon-name`, `gicon`, `icon-reactive`, `icon-label`,
  `menu-enabled`, signal `icon-clicked`, and `.slider` (a `Slider` with
  `value`, `drag-begin` and `drag-end`).
- Templates in the Shell: `js/ui/status/darkMode.js` (simple toggle),
  `status/doNotDisturb.js` (toggle bound to GSettings, 49+), and
  `status/volume.js` (slider).

## 5. Ordering, column span, replacing built-ins
- Full-width item: `addExternalIndicator(ind, 2)` or
  `menu.addItem(item, 2)`/`menu.insertItemBefore(item, sibling, colSpan)`.
- Custom position: skip `addExternalIndicator`. Do
  `qs._indicators.insert_child_at_index(ind, n)` and
  `qs.menu.insertItemBefore(item, qs.menu.getFirstItem(), colSpan)` yourself,
  and undo both in `disable()`.
- To hide a built-in, set `qs._nightLight.quickSettingsItems[0].visible = false`
  in enable and restore it in disable. Never destroy a built-in. Guava's
  `(Kiwi: apps/quickSettingsDnDRemoval.js; Guava equivalent not verified)` finds the DND toggle by class or icon
  instead of private fields because of the 49 move.
- Wait for async setup before touching built-ins. Poll
  `qs._system`/`qs._volumeOutput` in an idle loop with a retry limit, or
  connect `qs.menu`'s `open-state-changed`. Remove the idle in `disable()`.
- `QuickSettingsMenu` has `_grid`, `_overlay` and `_setDimmed()`. Opening a
  `QuickMenuToggle` submenu slides it over the grid.

## 6. Control Center from scratch
To get a macOS look (tiles of different sizes, large sliders, a media module),
either:
1. Restyle the stock menu with CSS on `.quick-settings`,
   `.quick-toggle`, `.quick-menu-toggle`, `.quick-slider` and
   `.quick-settings-system-item`. This is the cheapest option, and DBus-backed
   built-ins keep working.
2. Use a separate `PanelMenu.Button` whose `menu` (a `PopupMenu.PopupMenu`)
   hosts your own `St.Widget` grid built from `QuickToggle` instances. Reuse
   built-ins by **re-parenting** their `quickSettingsItems` while open and
   putting them back on close or disable. This is fragile, so wrap it in
   try/catch and verify on every GNOME bump.
3. Hide the stock `quickSettings` container (`qs.container.hide()`) and bind
   your button to the stock keyboard shortcut. Restore it in `disable()`.

## 7. Pitfalls by version
- 48: QuickMenuToggle style class names changed (gjs.guide 48). Check your CSS
  selectors.
- 49: DND toggle moved from the calendar to Quick Settings (`DoNotDisturbSwitch`
  removed, EGO-C49-001). Per-monitor brightness sliders were added
  (NEWS 49.beta).
- 51: `menu.open()`/`close()` take `{animate}` (NEWS 51.alpha). Guava uses
  `MENU_CLOSE_ARGS` in `(Kiwi: apps/windowTitle.js; Guava equivalent not verified)`.
- Only `SystemIndicator` subclasses can go through `addExternalIndicator`. The
  items must be `QuickSettingsItem` subclasses for the grid layout to work.

## 8. Sources
- https://gjs.guide/extensions/topics/quick-settings.html
- https://gjs.guide/extensions/topics/popup-menu.html
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/quickSettings.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/panel.js (addToStatusArea, addExternalIndicator, _onMenuSet)
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/status/doNotDisturb.js
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/status/darkMode.js
