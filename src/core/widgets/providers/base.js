// SPDX-License-Identifier: GPL-3.0-or-later
// The shape every widget data provider has (core/widgets/model.js ProviderPool runs them):
// start() and stop() bracket its life, snapshot() is the current data (a plain object) and
// onChange(fn) tells the views when it changed. Everything a provider sets up goes into the
// CleanupRegistry it gets in start(), so stop() is one dispose.

import { CleanupRegistry } from '../../../lib/disposables.js';
import { Emitter } from '../model.js';

export class Provider {
    constructor(env) {
        this._env = env;
        this._changed = new Emitter();
        this._cleanup = null;
        this._data = this.initial();
    }

    /** The data before anything is known. */
    initial() {
        return {};
    }

    start() {
        this._cleanup = new CleanupRegistry();
        this.run(this._cleanup);
    }

    stop() {
        this._cleanup?.dispose();
        this._cleanup = null;
        this._data = this.initial();
    }

    get running() {
        return this._cleanup !== null;
    }

    /** Set up the data source; everything goes into `cleanup`. */
    run(_cleanup) {}

    snapshot() {
        return this._data;
    }

    onChange(fn) {
        return this._changed.connect(fn);
    }

    /** Replace the data and tell the views (only while running). */
    publish(data) {
        if (!this.running)
            return;
        this._data = data;
        this._changed.emit(data);
    }
}
