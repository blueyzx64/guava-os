// SPDX-License-Identifier: GPL-3.0-or-later
// "Copy code" for one-time codes in notifications. Every notification added to the message
// tray (banner or not, so Do Not Disturb does not hide the code) is read locally with
// model.detectCode(); nothing leaves the machine. A found code becomes a 30 s alert in the
// pill with a Copy button.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { detectCode } from '../model.js';

/**
 * @param {CleanupRegistry} cleanup
 * @param {{activity: Function}} sink
 */
export function watchCodes(cleanup, sink) {
    const tray = Main.messageTray;
    const watched = new Map(); // source -> handler id

    const read = (source, notification) => {
        const code = detectCode(`${notification.title ?? ''}\n${notification.body ?? ''}`);
        if (code)
            sink.activity('code', 'code', { code, app: source.title ?? '' }, { fresh: true });
    };
    const watch = source => {
        if (watched.has(source))
            return;
        watched.set(source, source.connect('notification-added', (s, n) => read(s, n)));
    };
    const unwatch = source => {
        const id = watched.get(source);
        if (id === undefined)
            return;
        watched.delete(source);
        source.disconnect(id);
    };

    cleanup.connect(tray, 'source-added', (_t, source) => watch(source));
    cleanup.connect(tray, 'source-removed', (_t, source) => unwatch(source));
    tray.getSources().forEach(watch);
    cleanup.add(() => {
        for (const [source, id] of watched) {
            try {
                source.disconnect(id);
            } catch (_e) {
                // Finalised already.
            }
        }
        watched.clear();
        sink.activity('code', 'code', null);
    });
}
