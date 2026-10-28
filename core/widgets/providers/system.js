// SPDX-License-Identifier: GPL-3.0-or-later
// System data: CPU use and memory, sampled every few seconds and only while a System widget
// is visible (the provider stops with the last one). Reads /proc/stat and /proc/meminfo
// asynchronously, so the compositor never waits on them.

import Gio from 'gi://Gio';

import { cpuUsage, parseCpu, parseMemory } from '../data.js';
import { Provider } from './base.js';

const INTERVAL_MS = 2000;
const HISTORY = 30;

function readText(path, cancel) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancel, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                resolve(new TextDecoder().decode(bytes));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class SystemProvider extends Provider {
    initial() {
        return { cpu: 0, history: [], memory: null };
    }

    run(cleanup) {
        const cancel = new Gio.Cancellable();
        cleanup.add(() => cancel.cancel());
        this._prev = null;
        this._history = [];
        this._sample(cancel);
        cleanup.timeout(INTERVAL_MS, () => {
            this._sample(cancel);
            return true;
        }, { name: 'guava-widgets-system' });
    }

    async _sample(cancel) {
        let stat, mem;
        try {
            [stat, mem] = await Promise.all([readText('/proc/stat', cancel), readText('/proc/meminfo', cancel)]);
        } catch (_e) {
            return; // cancelled, or no /proc: keep the last values
        }
        if (cancel.is_cancelled())
            return;
        const next = parseCpu(stat);
        const cpu = cpuUsage(this._prev, next);
        this._prev = next;
        this._history = [...this._history.slice(1 - HISTORY), cpu];
        this.publish({ cpu, history: this._history, memory: parseMemory(mem) });
    }
}
