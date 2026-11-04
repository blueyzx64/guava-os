// SPDX-License-Identifier: GPL-3.0-or-later
// The first Mission Control open of a session paints shaders, textures and styles nobody has
// painted yet (the Spaces bar's wallpaper thumbnails, labels, icons, the window picker): ~280 ms
// from key to first frame on the harness, against 50-80 ms for the next opens (D-021: a cold
// open must answer within 250 ms; B39).
//
// Once the login is over and the user has been still for a moment, the overview is painted once
// where nobody can see it, then put back: the overview group at 1/255 opacity and hidden from
// pointer picks, the window picker and the Spaces bar built in the WINDOW_PICKER state, two
// frames painted, everything torn down. Nothing calls Overview.show(), so the Overview never
// emits 'showing' or 'hidden' and the dock, the Stage Manager strip, the notch and the rest
// never react: the only trace is the one-off paint hitch, while the user is idle.
//
// A real open that starts during the warm-up (the 'showing' signal) ends it at once without
// tearing anything down: the Overview takes over the views and thumbnails already built.
//
// Shell API (GNOME 50, js/ui/overview.js, overviewControls.js, workspacesView.js,
// workspaceThumbnail.js): Main.overview._overview.controls (_stateAdjustment,
// _workspacesDisplay.hide(), _thumbnailsBox._createThumbnails()/_destroyThumbnails(),
// prepareToEnterOverview()), Main.layoutManager.overviewGroup, Shell.util_set_hidden_from_pick.

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ControlsState } from 'resource:///org/gnome/shell/ui/overviewControls.js';

import { WARM_RETRY_MS, warmVerdict } from './model.js';

const LOG = '[Guava] mission-control:';
const FRAMES = 2;          // painted frames to wait for: the first one is the expensive one
const GIVE_UP_MS = 1500;   // no paint in this time: tear down anyway

// Module state lives as long as the Shell process: a disable/enable (lock) does not warm again
let warmed = false;

/**
 * Warm the overview's first paint once this session, when the Shell is quiet.
 *
 * @param {import('../../lib/disposables.js').CleanupRegistry} cleanup
 * @param {{env?: {degraded?: boolean}}} motion ctx.motion
 * @param {(r: {frames: number, ms: number, tookOver: boolean}) => void} report called when a warm-up ends
 */
export function warmOverviewPaint(cleanup, motion, report) {
    let tries = 0;
    cleanup.timeout(WARM_RETRY_MS, () => {
        const verdict = warmVerdict({
            warmed,
            startingUp: !!Main.layoutManager._startingUp,
            overviewVisible: Main.overview.visible,
            modal: Main.modalCount > 0,
            degraded: !!motion.env?.degraded,
            idleMs: global.backend.get_core_idle_monitor().get_idletime(),
            tries,
        });
        if (verdict === 'skip')
            return GLib.SOURCE_REMOVE;
        if (verdict === 'wait') {
            tries++;
            return GLib.SOURCE_CONTINUE;
        }
        warmed = true;
        paintOnce(cleanup, report);
        return GLib.SOURCE_REMOVE;
    }, { name: 'guava mission control warm' });
}

function paintOnce(cleanup, report) {
    const controls = Main.overview._overview?.controls;
    const group = Main.layoutManager.overviewGroup;
    const box = controls?._thumbnailsBox;
    if (!controls?._stateAdjustment || !controls._workspacesDisplay || typeof box?._createThumbnails !== 'function' ||
        typeof box._destroyThumbnails !== 'function' || typeof controls.prepareToEnterOverview !== 'function') {
        console.warn(`${LOG} the overview internals were not found; no first-open warm-up`);
        return;
    }
    const opacity = group.opacity;
    const t0 = GLib.get_monotonic_time();
    let live = true;
    let frames = 0;
    const stage = global.stage;
    const ids = [];
    const holders = [];

    // keepViews: a real open took over, leave what the Overview now uses
    const finish = keepViews => {
        if (!live)
            return;
        live = false;
        report({ frames, ms: Math.round((GLib.get_monotonic_time() - t0) / 1000), tookOver: keepViews });
        ids.forEach(id => stage.disconnect(id));
        holders.forEach(id => Main.overview.disconnect(id));
        if (!keepViews) {
            controls._stateAdjustment.value = ControlsState.HIDDEN;
            box._destroyThumbnails();
            controls._workspacesDisplay.hide();
            group.hide();
        }
        Shell.util_set_hidden_from_pick(group, false);
        group.opacity = opacity;
    };
    cleanup.add(() => finish(Main.overview.visible));

    // Two steps, a frame apart, or Clutter warns "Can't update stage views ... needs an
    // allocation" for the overview's actors (measured in the harness, B39):
    //   1. the group is shown empty, so it gets its first allocation (Guava skips the login
    //      overview, so nothing has allocated it yet);
    //   2. it is hidden again, the views and thumbnails are built, and it is shown: thumbnails
    //      built inside a shown group are not allocated on the next frame.
    const build = () => {
        try {
            group.hide();
            controls.prepareToEnterOverview();
            box._createThumbnails();
            controls._stateAdjustment.value = ControlsState.WINDOW_PICKER;
            group.show();
        } catch (e) {
            console.warn(`${LOG} first-open warm-up failed: ${e.message}`);
            finish(false);
            return;
        }
        ids.push(stage.connect('after-paint', () => {
            if (++frames === FRAMES)
                cleanup.idle(() => finish(false), { name: 'guava mission control warm end' });
        }));
    };
    try {
        group.opacity = 1;
        Shell.util_set_hidden_from_pick(group, true);
        group.show();
    } catch (e) {
        console.warn(`${LOG} first-open warm-up failed: ${e.message}`);
        finish(false);
        return;
    }
    holders.push(Main.overview.connect('showing', () => finish(true)));
    const first = stage.connect('after-paint', () => {
        stage.disconnect(first);
        ids.splice(ids.indexOf(first), 1);
        if (live)
            cleanup.idle(() => live && build(), { name: 'guava mission control warm build' });
    });
    ids.push(first);
    stage.queue_redraw();
    cleanup.timeout(GIVE_UP_MS, () => {
        finish(false);
        return GLib.SOURCE_REMOVE;
    }, { name: 'guava mission control warm limit' });
}
