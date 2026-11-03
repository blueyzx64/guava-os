// SPDX-License-Identifier: GPL-3.0-or-later
// Pure logic of the App Menus setup helpers in the preferences (no Gio, no files):
//   - Chromium and Electron apps read ~/.config/<name>-flags.conf at start. Running them on X11
//     (--ozone-platform=x11) lets them hand their menu to the menu bar through the registrar.
//     Guava writes one marked line and removes exactly that line again.
//   - Flatpak apps can only reach the registrar when the sandbox allows that bus name.
// Tests: tests/appMenusSetup.test.js

export const FLAGS_MARK = '# guava-os: app menus';
export const X11_FLAG = '--ozone-platform=x11';
export const REGISTRAR_NAME = 'com.canonical.AppMenu.Registrar';

const LINE = `${X11_FLAG} ${FLAGS_MARK}`;

/**
 * Apps that read a flags file. `exec` lists executable names that identify the app in its
 * desktop entry; `file` is the name under ~/.config.
 */
export const FLAG_APPS = Object.freeze([
    { id: 'chromium', name: 'Chromium', file: 'chromium-flags.conf', exec: ['chromium', 'chromium-browser'] },
    { id: 'chrome', name: 'Google Chrome', file: 'chrome-flags.conf', exec: ['google-chrome', 'google-chrome-stable'] },
    { id: 'brave', name: 'Brave', file: 'brave-flags.conf', exec: ['brave', 'brave-browser'] },
    { id: 'edge', name: 'Microsoft Edge', file: 'microsoft-edge-stable-flags.conf', exec: ['microsoft-edge', 'microsoft-edge-stable'] },
    { id: 'vivaldi', name: 'Vivaldi', file: 'vivaldi-stable.conf', exec: ['vivaldi', 'vivaldi-stable'] },
    { id: 'code', name: 'Visual Studio Code', file: 'code-flags.conf', exec: ['code'] },
    { id: 'electron', name: 'Electron apps', file: 'electron-flags.conf', exec: ['electron'] },
]);

/** True when the file text has Guava's marked line. */
export function hasX11Flag(text) {
    return (text ?? '').split('\n').some(l => l.trim() === LINE);
}

/** @returns {string} the text with Guava's line added once (other lines untouched) */
export function withX11Flag(text) {
    const t = text ?? '';
    if (hasX11Flag(t))
        return t;
    const sep = t === '' || t.endsWith('\n') ? '' : '\n';
    return `${t}${sep}${LINE}\n`;
}

/** @returns {string} the text without Guava's line (and nothing else changed) */
export function withoutX11Flag(text) {
    return (text ?? '').split('\n').filter(l => l.trim() !== LINE).join('\n');
}

/**
 * Which known flag apps are installed, from the executable names of desktop entries.
 *
 * @param {string[]} execNames basenames of every installed app's Exec program
 * @returns {object[]} FLAG_APPS entries found, in list order
 */
export function detectFlagApps(execNames) {
    const have = new Set(execNames);
    return FLAG_APPS.filter(a => a.exec.some(e => have.has(e)));
}

/** The program name of a desktop entry's Exec line ("env X=1 /usr/bin/code %F" -> "code"). */
export function execProgram(commandline) {
    const words = (commandline ?? '').trim().split(/\s+/);
    let i = 0;
    if (/(^|\/)env$/.test(words[0] ?? '')) {
        i = 1;
        while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))
            i++;
    }
    const prog = words[i] ?? '';
    return prog.slice(prog.lastIndexOf('/') + 1);
}

/** A Flatpak application id (reverse DNS), safe to pass as an argument. */
export function isFlatpakId(id) {
    return /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*){2,}$/.test(id ?? '');
}

/**
 * The flatpak command that lets an app talk to the registrar (allow) or takes that away again.
 *
 * @returns {?string[]} argv, or null for an id that is not a Flatpak id
 */
export function flatpakOverrideArgv(id, allow) {
    if (!isFlatpakId(id))
        return null;
    return ['flatpak', 'override', '--user',
        `${allow ? '--talk-name' : '--no-talk-name'}=${REGISTRAR_NAME}`, id];
}

/** Parse `flatpak list --app --columns=application` output. */
export function parseFlatpakList(out) {
    return [...new Set((out ?? '').split('\n').map(l => l.trim()).filter(isFlatpakId))].sort();
}

/** True when `flatpak override --user --show <id>` output grants the registrar. */
export function overrideAllows(out) {
    return (out ?? '').split('\n').some(l => l.trim() === `${REGISTRAR_NAME}=talk`);
}
