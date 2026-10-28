// SPDX-License-Identifier: GPL-3.0-or-later
// Toggle shortcut for Stage Manager. It is its own features.js entry (not part of StageManager)
// so the binding survives while Stage Manager is off and can turn it back on.

import { Keybindings } from '../../lib/keybindings.js';

export class StageManagerShortcut {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
    }

    enable() {
        const settings = this._ctx.settings;
        Keybindings.add(this._cleanup, 'stage-manager-shortcut', settings, () => {
            settings.set_boolean('stage-manager', !settings.get_boolean('stage-manager'));
        });
    }

    disable() {
        // The binding is removed by the entry's cleanup registry.
    }
}
