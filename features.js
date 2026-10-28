// SPDX-License-Identifier: GPL-3.0-or-later
// The list of Guava features, in start order (stop runs in reverse).
// The engine is lib/featureRegistry.js; see its header for the entry shape.
//
// To add a feature (docs/architecture/conventions.md): create features/<name>/, then add ONE
// entry below with `setting` (its on/off key) or `when`, `load` (a dynamic import, so a
// feature that is off costs nothing), and `conflictsWith` / `needs` if it shares a resource
// with another feature. Put everything it sets up in the `cleanup` registry it is given.
//
// Shared-resource rules, defined once here:
//   - button-layout: app-buttons owns it (the user's value is restored on disable).
//   - Do Not Disturb: the Control Center provides it while on (dnd-button steps aside).
//   - Stage Manager owns window placement: fullscreen-to-its-own-Space pauses (its saved
//     value is kept).
//   - The notch owns the centre of the top bar: the date menu moves right (calendar).
//   - Focus owns Do Not Disturb's tile while it runs (the stock one is hidden; the Control
//     Center places the Focus tile in its slot); the notch's banners pass Focus's filter.
//   - Tiling shortcuts: window-tiling binds only accelerators that no stock GNOME binding and no
//     running Guava shortcut holds (Stage Manager's Ctrl+Super+Down wins while it runs).
//   - Status items: the AppIndicator extension, when enabled, owns org.kde.StatusNotifierWatcher;
//     menu-bar-items then only orders and hides its icons (decided at run time, not here).
//   - Guava's dock owns the dock: Dash to Dock is kept off while it runs (core/originals).

// ctx: see extension.js (settings, gettext, events, desktop, layout, motion, originals, ...)
const bool = (ctx, key) => ctx.settings.get_boolean(key);
const HOT_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// The date menu leaves the centre box when the user asked for it, and always while the notch
// owns the centre. The message list moves to Quick Settings with it.
const calendarRight = ctx => bool(ctx, 'move-calendar-right') || bool(ctx, 'notch');
const notificationsInQuickSettings = ctx => calendarRight(ctx) && !bool(ctx, 'keep-notification-panel');

/** @type {object[]} */
export const FEATURES = [
    {
        // GTK stylesheets for the apps' own titlebars (macOS traffic lights, app fixes). Always runs: it writes an empty block (none) when nothing is wanted.
        id: 'gtk-theme',
        load: async () => (await import('./features/appButtons/gtkTheme.js')).GtkTheme,
    },
    {
        // The macOS menu bar: logo menu, app name and menus (core/appMenus), transparent
        // adaptive look, full-screen reveal, privacy dots; each part has its own key
        id: 'menu-bar',
        load: async () => (await import('./features/menuBar/index.js')).MenuBar,
    },
    {
        // Full screen as its own Space, the macOS default
        id: 'move-window-to-new-workspace', setting: 'move-window-to-new-workspace',
        load: async () => (await import('./features/fullscreenSpace/index.js')).FullscreenSpace,
    },

    // Calendar group. The calendar re-attaches the date menu at the far right of the panel,
    // so a change of keep-notification-panel restarts it and the notification pieces together.
    {
        id: 'calendar', when: calendarRight,
        restartOn: ['keep-notification-panel'],
        load: async () => (await import('./features/calendar/index.js')).Calendar,
    },
    {
        id: 'quick-settings-notifications', when: notificationsInQuickSettings,
        restartOn: ['keep-notification-panel'],
        load: async () => (await import('./features/calendar/notificationList.js')).QuickSettingsNotifications,
    },
    {
        // The Control Center has its own Do Not Disturb tile and wins (conflictsWith there)
        id: 'dnd-button',
        when: ctx => notificationsInQuickSettings(ctx) && bool(ctx, 'custom-dnd-button'),
        restartOn: ['keep-notification-panel'],
        load: async () => (await import('./features/calendar/dndButton.js')).DndButton,
    },

    {
        // The apps' own titlebar buttons: Guava sets the WM button-layout (side, button set) and
        // never draws window buttons in the top bar. Always on; core/originals restores the
        // user's layout.
        id: 'app-buttons',
        load: async () => (await import('./features/appButtons/index.js')).AppButtonsFeature,
    },
    {
        // Sequoia tiling: drag zones, the drag-to-top layout picker, Ctrl+Super shortcuts.
        // Owns org.gnome.mutter edge-tiling (off while it runs). Asked through 'window-tile-requested'.
        id: 'window-tiling', setting: 'windows-tiling',
        load: async () => (await import('./features/windows/index.js')).WindowTiling,
    },
    {
        // Hide / Hide Others (Super+H, 'app-hide-requested'); takes Super+H from GNOME's minimize
        id: 'app-hide', setting: 'windows-app-hide',
        load: async () => (await import('./features/windows/hide.js')).AppHide,
    },
    {
        // Local clipboard history; its panel icon claims a slot through PanelLayout
        id: 'clipboard-history', setting: 'clipboard-history',
        load: async () => (await import('./features/clipboard/index.js')).ClipboardHistory,
    },
    {
        // Top-bar button, Super+D and a click on empty wallpaper slide the windows aside; hands
        // off to Stage Manager's toggleDesktop() while that runs (looked up through ctx.features)
        id: 'show-desktop',
        when: ctx => bool(ctx, 'show-desktop-button') ||
            ctx.settings.get_strv('show-desktop-shortcut').length > 0 ||
            ctx.settings.get_string('click-wallpaper-reveals-desktop') !== 'never',
        keys: ['show-desktop-button', 'click-wallpaper-reveals-desktop'],
        restartOn: ['show-desktop-shortcut'],
        load: async () => (await import('./features/showDesktop/index.js')).ShowDesktop,
    },
    {
        // Full-screen app grid with folders and jiggle delete; GNOME's folders and order are
        // its data. Takes Super+A from GNOME's app grid while on (core/originals).
        id: 'launchpad', setting: 'launchpad',
        load: async () => (await import('./features/launchpad/index.js')).Launchpad,
    },
    {
        // Full screen Split View (shortcuts on a full-screen window); builds on full screen as its own Space
        id: 'split-view', setting: 'split-view',
        load: async () => (await import('./features/splitView/index.js')).SplitView,
    },
    {
        // Super tap / shortcut opens Spotlight; the clipboard rows come from clipboard-history
        id: 'spotlight', setting: 'spotlight',
        load: async () => (await import('./features/spotlight/index.js')).SpotlightFeature,
    },
    {
        // Auto Light/Dark, the accent and the highlight colour; each part has its own key and
        // owns nothing while that key is at its default
        id: 'appearance',
        load: async () => (await import('./features/appearance/scheme.js')).Appearance,
    },
    {
        // macOS text rendering and font (each part has its own key)
        id: 'typography',
        load: async () => (await import('./features/typography/index.js')).Typography,
    },
    {
        id: 'popup-menu-styling', setting: 'popup-menu-styling',
        load: async () => (await import('./features/appearance/index.js')).PopupMenuStyling,
    },
    {
        // Translucent panel, menus and overlays (lib/glass.js does the work)
        id: 'liquid-glass', setting: 'liquid-glass',
        load: async () => (await import('./features/liquidGlass/index.js')).LiquidGlass,
    },
    {
        // Overview swipes stop at the workspace overview; no hot corner. Each part has its key.
        id: 'shell-behaviour',
        when: ctx => bool(ctx, 'overview-gestures-workspace-only') || bool(ctx, 'disable-hot-corner'),
        restartOn: ['overview-gestures-workspace-only', 'disable-hot-corner'],
        load: async () => (await import('./features/shellBehaviour/index.js')).ShellBehaviour,
    },
    {
        // The overview restyled as Mission Control, App Exposé, start on the desktop. It owns
        // dynamic-workspaces (static Spaces) and app-switcher current-workspace-only through
        // core/originals; the dock and the Stage Manager strip hide with the overview.
        id: 'mission-control', setting: 'mission-control',
        restartOn: ['mission-control-shortcut', 'app-expose-shortcut', 'mc-static-spaces'],
        load: async () => (await import('./features/missionControl/index.js')).MissionControl,
    },
    {
        // macOS-style rounded corners: one shader effect per window actor
        id: 'rounded-corners', setting: 'rounded-corners',
        load: async () => (await import('./features/roundedCorners/index.js')).RoundedCorners,
    },
    {
        // Low Power Mode per power source (power-profiles-daemon holds). Always runs; it holds
        // nothing until one of its two choices is on, and idles without the daemon.
        id: 'low-power',
        load: async () => (await import('./features/lowPower/index.js')).LowPower,
    },
    {
        // Quick Settings restyled as a Control Center; last of the panel features so it sees
        // the others
        id: 'control-center', setting: 'control-center',
        conflictsWith: ['dnd-button'],
        load: async () => (await import('./features/controlCenter/index.js')).ControlCenter,
    },
    {
        // The right side of the menu bar: apps' status icons (StatusNotifierItem host, or the
        // AppIndicator extension's icons when it is enabled), Control Center controls pinned
        // to the bar, and the item manager (order, hidden items, overflow chevron)
        id: 'menu-bar-items',
        load: async () => (await import('./features/menuBarItems/index.js')).MenuBarItems,
    },
    {
        // Guava's own dock on the bottom (or a side) edge, claimed through core/layout. It takes
        // Dash to Dock out of the enabled extensions while it runs and puts it back after.
        id: 'dock', setting: 'dock',
        load: async () => (await import('./features/dock/index.js')).Dock,
    },
    {
        // Genie / Scale minimize into the dock (or any target a provider gives). 'gnome' keeps
        // GNOME's own effect, so the feature does not run then.
        id: 'minimize-effect',
        when: ctx => ctx.settings.get_string('dock-minimize-effect') !== 'gnome',
        keys: ['dock-minimize-effect'],
        load: async () => (await import('./features/minimizeEffect/index.js')).MinimizeEffect,
    },
    {
        // Stage Manager wins over fullscreen-to-its-own-Space; its saved value is kept
        id: 'stage-manager', setting: 'stage-manager',
        conflictsWith: ['move-window-to-new-workspace'],
        // How entries are grouped is the shape of the whole state: rebuilt from scratch
        restartOn: ['stage-manager-group-by-app'],
        load: async () => (await import('./features/stageManager/index.js')).StageManager,
    },
    {
        // Its own entry so the shortcut still works while Stage Manager is off
        id: 'stage-manager-shortcut',
        when: ctx => ctx.settings.get_strv('stage-manager-shortcut').length > 0,
        restartOn: ['stage-manager-shortcut'],
        load: async () => (await import('./features/stageManager/shortcut.js')).StageManagerShortcut,
    },
    {
        // Caps Lock and input-source badge at the text caret (lib/caret.js)
        id: 'input-indicator', setting: 'input-indicator',
        load: async () => (await import('./features/inputIndicator/index.js')).InputIndicator,
    },
    {
        // Emoji & Symbols popover (Super+Ctrl+Space); types through lib/paste.js
        id: 'emoji-picker', setting: 'emoji-picker',
        load: async () => (await import('./features/emoji/index.js')).EmojiPicker,
    },
    {
        // Pill in the centre of the bar for banners, media and volume. Replaces the stock banners
        // and OSD (parts switch live on notch-notifications / notch-live-activities; volume and brightness
        // come from core/osd.js while osd-location is 'notch').
        id: 'notch', setting: 'notch',
        load: async () => (await import('./features/notch/index.js')).NotchFeature,
    },
    {
        // The clock opens a right-side column (the menu bar emits notification-center-requested):
        // the date, the history grouped by app, widgets. Off: the calendar card opens instead.
        id: 'notification-center', setting: 'notification-center',
        load: async () => (await import('./features/notificationCenter/index.js')).NotificationCenter,
    },
    {
        // Focus modes over GNOME's Do Not Disturb: holds back banners through
        // NotificationRouter.setBannerFilter; its tile takes Do Not Disturb's place
        id: 'focus', setting: 'focus-modes',
        load: async () => (await import('./features/focus/index.js')).Focus,
    },
    {
        // Shift+Super+3/4/5, the toolbar and the floating thumbnail, on GNOME's own screenshot UI
        id: 'screenshots', setting: 'screenshots',
        restartOn: ['screenshots-shortcut-screen', 'screenshots-shortcut-selection', 'screenshots-shortcut-toolbar'],
        load: async () => (await import('./features/screenshots/index.js')).Screenshots,
    },
    {
        // Super+Tab and Super+`: Guava's handlers for switch-applications and switch-group while
        // on, the Shell's own given back after (the user's shortcuts are never written)
        id: 'app-switcher', setting: 'app-switcher',
        restartOn: ['switcher-cycle-windows'],
        load: async () => (await import('./features/switcher/index.js')).AppSwitcher,
    },
    {
        // 3/4-finger touchpad gestures; GNOME's own swipes stay (the router only watches them)
        id: 'gestures', setting: 'gestures',
        load: async () => (await import('./features/gestures/index.js')).Gestures,
    },
    {
        // Four hot corners; off (no barriers) while every corner is 'none', the macOS default
        id: 'hot-corners',
        when: ctx => HOT_CORNERS.some(c => ctx.settings.get_string(`hot-corner-${c}`) !== 'none'),
        load: async () => (await import('./features/hotCorners/index.js')).HotCorners,
    },
    {
        // The Tahoe volume / brightness pill under the menu bar: a sink of core/osd.js, which
        // routes each change to the notch or here (osd-location). Off with 'system'.
        id: 'osd', when: ctx => ctx.settings.get_string('osd-location') !== 'system',
        keys: ['osd-location'],
        load: async () => (await import('./features/osd/index.js')).OsdPill,
    },
    {
        // macOS-style glass alerts: the Shell's modal dialogs restyled (theme only)
        id: 'dialogs', setting: 'dialogs-glass',
        load: async () => (await import('./features/dialogs/index.js')).Dialogs,
    },
    {
        // Accessibility colour filters on the whole screen (one shader effect on the stage)
        id: 'color-filters', setting: 'color-filter',
        load: async () => (await import('./features/colorFilters/index.js')).ColorFilters,
    },
    {
        // Desktop widgets above the wallpaper, below windows (core/widgets is the shared model)
        id: 'desktop-widgets', setting: 'widgets',
        load: async () => (await import('./features/widgets/index.js')).DesktopWidgets,
    },
    {
        // The Finder desktop: the files of ~/Desktop as icons from the top-right corner, below the
        // widgets. Steps aside itself while Desktop Icons NG (DING) is enabled (see its header).
        id: 'desktop-icons', setting: 'desktop-icons',
        load: async () => (await import('./features/desktopIcons/index.js')).DesktopIcons,
    },
    {
        // The Setup Assistant, offered once (features/onboarding/model.js): runs only while
        // it has never been offered, opens the preferences, then stops
        id: 'onboarding', when: ctx => ctx.settings.get_string('onboarding') === 'new',
        load: async () => (await import('./features/onboarding/index.js')).Onboarding,
    },
];
