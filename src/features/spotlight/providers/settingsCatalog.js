// SPDX-License-Identifier: GPL-3.0-or-later
// Static catalog for the Settings group: GNOME Settings panels and Guava's own switches.
// Pure data and functions (no gi imports). Titles go through `_` at the call site.

const N_ = s => s;

/**
 * GNOME Settings (gnome-control-center) panels. `panel` is the argument to the command.
 * Checked against gnome-control-center gnome-50 shell/cc-panel-loader.c (tests keep it so).
 */
export const PANELS = [
    { panel: 'wifi', title: N_('Wi-Fi'), keywords: ['wireless', 'network', 'internet'] },
    { panel: 'network', title: N_('Network'), keywords: ['ethernet', 'vpn', 'proxy', 'internet'] },
    { panel: 'bluetooth', title: N_('Bluetooth'), keywords: ['pair', 'wireless', 'devices'] },
    { panel: 'display', title: N_('Displays'), keywords: ['monitor', 'resolution', 'scale', 'night light', 'refresh rate'] },
    { panel: 'sound', title: N_('Sound'), keywords: ['audio', 'volume', 'speakers', 'microphone', 'output', 'input'] },
    { panel: 'power', title: N_('Power'), keywords: ['battery', 'sleep', 'suspend', 'power saver'] },
    { panel: 'keyboard', title: N_('Keyboard'), keywords: ['shortcuts', 'input source', 'layout', 'typing'] },
    { panel: 'mouse', title: N_('Mouse & Touchpad'), keywords: ['pointer', 'scrolling', 'tap', 'trackpad'] },
    // GNOME 50 has no separate 'appearance' panel: style and wallpaper live in 'background'
    { panel: 'background', title: N_('Appearance'), keywords: ['wallpaper', 'background', 'desktop picture', 'dark style', 'dark mode', 'accent', 'style', 'theme'] },
    { panel: 'notifications', title: N_('Notifications'), keywords: ['do not disturb', 'banners', 'alerts'] },
    { panel: 'search', title: N_('Search'), keywords: ['search providers', 'files'] },
    { panel: 'multitasking', title: N_('Multitasking'), keywords: ['hot corner', 'workspaces', 'dynamic workspaces', 'active screen edges'] },
    { panel: 'applications', title: N_('Apps'), keywords: ['default applications', 'permissions'] },
    { panel: 'privacy', title: N_('Privacy & Security'), keywords: ['location', 'camera', 'screen lock', 'history', 'microphone'] },
    { panel: 'online-accounts', title: N_('Online Accounts'), keywords: ['google', 'nextcloud', 'sign in'] },
    { panel: 'sharing', title: N_('Sharing'), keywords: ['remote desktop', 'screen sharing', 'media sharing', 'hostname'] },
    { panel: 'printers', title: N_('Printers'), keywords: ['printing', 'scanner'] },
    { panel: 'color', title: N_('Color'), keywords: ['color profile', 'calibration'] },
    { panel: 'datetime', title: N_('Date & Time'), keywords: ['clock', 'timezone', 'time zone'] },
    { panel: 'region', title: N_('Region & Language'), keywords: ['locale', 'formats', 'language'] },
    { panel: 'universal-access', title: N_('Accessibility'), keywords: ['universal access', 'zoom', 'text size', 'screen reader', 'reduce motion'] },
    { panel: 'wellbeing', title: N_('Digital Wellbeing'), keywords: ['screen time', 'breaks', 'usage limits', 'eye strain'] },
    { panel: 'users', title: N_('Users'), keywords: ['accounts', 'password', 'login', 'avatar'] },
    { panel: 'system', title: N_('System'), keywords: ['about', 'updates', 'software', 'date', 'region'] },
    { panel: 'about', title: N_('About'), keywords: ['device name', 'version', 'hardware', 'system info'] },
];

/** Guava switches the spec names. `key` is a boolean key in Guava's schema. */
export const GUAVA_TOGGLES = [
    { key: 'liquid-glass', title: N_('Liquid Glass'), keywords: ['blur', 'translucent', 'glass', 'transparency'] },
    { key: 'stage-manager', title: N_('Stage Manager'), keywords: ['windows', 'stage', 'strip'] },
];

/**
 * Build the Settings items. `has(key)` tells whether a schema key exists, `read(key)` its value,
 * so a toggle for a feature that is not installed yet never shows.
 *
 * @param {Function} _ gettext
 * @param {{has:(k:string)=>boolean, read:(k:string)=>boolean, panelsAvailable:boolean}} env
 */
export function settingsItems(_, env) {
    const items = [];
    if (env.panelsAvailable) {
        for (const p of PANELS) {
            items.push({
                id: `setting:${p.panel}`, kind: 'setting', title: _(p.title),
                subtitle: _('Settings'), keywords: p.keywords, iconName: 'preferences-system-symbolic',
                action: { type: 'panel', panel: p.panel },
            });
        }
    }
    for (const t of GUAVA_TOGGLES) {
        if (!env.has(t.key))
            continue;
        const on = env.read(t.key);
        items.push({
            id: `guava:${t.key}`, kind: 'action', title: _(t.title),
            subtitle: on ? _('Guava · On, press Return to turn off') : _('Guava · Off, press Return to turn on'),
            keywords: t.keywords, iconName: 'preferences-desktop-appearance-symbolic',
            action: { type: 'toggle', key: t.key, to: !on },
        });
    }
    items.push({
        id: 'guava:prefs', kind: 'action', title: _('Guava Settings'), subtitle: _('Guava'),
        keywords: ['guava', 'extension', 'preferences', 'spotlight'],
        iconName: 'emblem-system-symbolic', action: { type: 'guava-prefs' },
    });
    return items;
}
