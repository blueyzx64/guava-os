// SPDX-License-Identifier: GPL-3.0-or-later
// Liquid Glass: applies lib/glass.js to the stock Shell surfaces Guava restyles.
//
// The look lives on the surface actor itself (lib/glass.js: classes and the blur effect), so
// every surface keeps its own rounded shape:
// - panel   : the top bar (the menu bar feature may take it over).
// - menus   : Control Center and the calendar card, through Glass.attachMenu(): the menu box
//             is the glass, its BoxPointer bin carries the drop shadow.
// - dock    : Guava's own dock attaches itself.
// - overlays: not attached here. Spotlight and Quick Paste (lib/modalSurface.js), the
//             clipboard popover and the Stage Manager floor attach themselves.
//
// Everything lives in the entry's CleanupRegistry; disable() has nothing left to do.

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Glass } from '../../lib/glass.js';
import { setDegraded } from '../../lib/glassBlur.js';

export class LiquidGlass {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._panel = null;     // {handle, restore}
        this._menus = new Map();   // menu -> {handle, token, destroyToken}
    }

    enable() {
        const cleanup = this._cleanup;

        // The theme's text colour decides dark or light glass: re-read it on a theme change
        cleanup.connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => this._refreshAll());
        cleanup.add(() => this._detachAll());

        // B28: while the frame budget is blown live blur refreshes slowly (glassParams.liveCaptureDue)
        setDegraded(this._ctx.motion.env.degraded);
        this._ctx.events.on('motion-changed', env => setDegraded(env.degraded), cleanup);
        cleanup.add(() => setDegraded(false));

        // Calls back now, so the first sync happens here
        Glass.watch(cleanup, () => this._sync());
    }

    disable() {
        // Cleanup registry does the work (this._detachAll runs on dispose)
    }

    // ---- sync ------------------------------------------------------------

    _sync() {
        const panelWanted = Glass.wants('panel');
        if (panelWanted && !this._panel)
            this._attachPanel();
        else if (!panelWanted && this._panel)
            this._detachPanel();

        if (Glass.wants('menus'))
            this._attachMenus();
        else
            this._detachMenus();

        this._refreshAll();
    }

    _refreshAll() {
        this._panel?.handle.refresh();
        for (const state of this._menus.values())
            state.handle.refresh();
    }

    // ---- panel -------------------------------------------------------------

    _attachPanel() {
        const panel = Main.panel;
        const handle = Glass.attach(panel, { surface: 'panel' });

        const reg = this._cleanup;
        const sync = () => {
            // Hidden over full screen: the panel falls back to its theme colour
            handle.setVisible(!(Main.layoutManager.primaryMonitor?.inFullscreen ?? false));
        };
        // Mission Control: the glass fades with the overview's own progress (its state
        // adjustment: 0 hidden, 1 window picker), so the bar follows every frame of the
        // animation, a gesture, and an open interrupted by a close, with nothing of its own to
        // run or retarget.
        const adjustment = Main.overview._overview?.controls?._stateAdjustment ?? null;
        // Only while the overview is open: features/missionControl/warm.js moves the adjustment
        // for an invisible first paint with the overview closed, and the bar must not fade then
        const follow = () => {
            const v = !Main.overview.visible ? 0 : adjustment ? adjustment.value : 1;
            handle.setPresence(1 - Math.min(1, Math.max(0, v)));
        };
        const tokens = [
            reg.connect(global.display, 'in-fullscreen-changed', sync),
            reg.connect(Main.overview, 'showing', follow),
            reg.connect(Main.overview, 'hidden', follow),
        ];
        if (adjustment)
            tokens.push(reg.connect(adjustment, 'notify::value', follow));
        sync();
        follow();
        this._panel = { handle, tokens };
    }

    _detachPanel() {
        const { handle, tokens } = this._panel;
        this._panel = null;
        tokens.forEach(t => this._cleanup.release(t));
        handle.destroy();
    }

    // ---- menus -------------------------------------------------------------

    _menuTargets() {
        const area = Main.panel.statusArea;
        return [area.quickSettings?.menu, area.dateMenu?.menu].filter(menu => menu?.box);
    }

    _attachMenus() {
        for (const menu of this._menuTargets()) {
            if (this._menus.has(menu))
                continue;
            // The theme's text colour on the menu box picks dark or light glass (lib/glass.js)
            const handle = Glass.attachMenu(menu);
            const state = { handle };
            // Menu destroyed under us: forget it (the handle dies with the box)
            state.destroyToken = this._cleanup.connect(menu, 'destroy', () => this._menus.delete(menu));
            this._menus.set(menu, state);
        }
    }

    _detachMenu(menu, state) {
        this._cleanup.release(state.destroyToken);
        state.handle.destroy();
        this._menus.delete(menu);
    }

    _detachMenus() {
        for (const [menu, state] of [...this._menus])
            this._detachMenu(menu, state);
    }

    _detachAll() {
        if (this._panel)
            this._detachPanel();
        this._detachMenus();
    }
}
