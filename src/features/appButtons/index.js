// SPDX-License-Identifier: GPL-3.0-or-later
// The apps' own titlebar buttons. Window buttons always stay on the app's titlebar; Guava never
// draws them in the top bar. Guava sets the WM button-layout to all three buttons (or close only,
// app-buttons-set) on the side from window-controls-side. The user's layout is kept by
// core/originals (crash-safe) and written back exactly when Guava is disabled.
// The look (stock GNOME or Guava's macOS CSS) is the GTK CSS of gtkTheme.js, which reads
// app-buttons-style.

import Gio from 'gi://Gio';

import { GuavaSettings } from '../../lib/settings.js';
import { ButtonLayoutOwner, WM_SCHEMA } from './buttonLayout.js';
import { appButtonsLayout } from './model.js';

const KEYS = ['window-controls-side', 'app-buttons-set'];

export class AppButtonsFeature {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._owner = null;
    }

    enable() {
        const { settings } = this._ctx;
        const cleanup = this._cleanup;
        const ks = new GuavaSettings(settings);
        ks.attach(cleanup);

        const wm = new Gio.Settings({ schema_id: WM_SCHEMA });
        this._owner = new ButtonLayoutOwner(this._ctx.originals, wm, () => {},
            original => appButtonsLayout(original, {
                position: ks.string('window-controls-side'),
                set: ks.string('app-buttons-set'),
            }));
        // LIFO: released before the settings watcher goes
        cleanup.add(() => {
            this._owner.release();
            this._owner = null;
        });
        this._owner.sync(true);
        ks.watch(KEYS, () => this._owner?.reapply());
    }

    disable() {
        // The cleanup registry, disposed right after this, releases the layout.
    }
}
