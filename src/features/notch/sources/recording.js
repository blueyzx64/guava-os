// SPDX-License-Identifier: GPL-3.0-or-later
// Screen recording: the red capsule with elapsed time and a stop button.
//
// The activity follows the core events 'recording-started' / 'recording-stopped' (emitted by
// the screenshots feature), and the Shell's own screenshot UI property `screencast-in-progress`
// (js/ui/screenshot.js, GNOME 45-51) so a recording still shows while that feature is off. Both
// describe the same recorder, so either one starting or stopping it is enough.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const nowMs = () => Math.floor(GLib.get_monotonic_time() / 1000);

/**
 * @param {CleanupRegistry} cleanup
 * @param {EventHub} events
 * @param {{activity: Function}} sink
 */
export function watchRecording(cleanup, events, sink) {
    let startedAt = null;
    const set = on => {
        if (on === (startedAt !== null))
            return;
        startedAt = on ? nowMs() : null;
        sink.activity('recording', 'recording', on ? { startedAt } : null);
    };
    events.on('recording-started', () => set(true), cleanup);
    events.on('recording-stopped', () => set(false), cleanup);
    const ui = Main.screenshotUI;
    if (ui) {
        cleanup.connect(ui, 'notify::screencast-in-progress', () => set(!!ui.screencast_in_progress));
        set(!!ui.screencast_in_progress);
    }
    cleanup.add(() => sink.activity('recording', 'recording', null));
}

/** Stop the Shell's recording (the capsule's stop button). */
export function stopRecording() {
    Main.screenshotUI?.stopScreencast?.().catch?.(e => console.error('[Guava] notch: stop recording failed:', e));
}
