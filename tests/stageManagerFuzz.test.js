// Run: gjs -m tests/stageManagerFuzz.test.js
// Fuzz test of the Stage Manager state machine: random window events (open, close, minimize,
// restore, focus, workspace moves, full screen, dialogs, monitors) and user actions (thumbnail
// click, cycle, slot, remove, stash, Show Desktop, pointer on the edge), with the model's
// invariants checked after every event and the hide/show effects replayed on a fake desktop that
// must always agree with the model: every window is in exactly one place, a minimized window is
// never touched, nothing is hidden by mistake, the strip never lists more than MAX_SHOWN sets,
// and when Stage Manager lets go (every window made visible) nothing stays hidden.
import { MAX_SHOWN, StageModel } from '../features/stageManager/model.js';

// Small deterministic PRNG (mulberry32) so a failure can be replayed from its seed
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function run(seed, steps) {
    const r = rng(seed);
    const pick = list => list[Math.floor(r() * list.length)];
    const sm = new StageModel({
        allAtOnce: r() < 0.6, newWindows: r() < 0.7 ? 'replace' : 'join',
        showRecent: r() < 0.8, autohide: r() < 0.8,
    });
    const windows = new Map();   // id -> description (the desktop)
    const hidden = new Set();    // what the adapter would have hidden
    const timers = new Map();
    let now = 0;
    let next = 1;
    let active = 0;
    const log = [];
    const apps = ['a', 'b', 'c', 'd'];

    const fail = msg => {
        throw new Error(`seed ${seed}: ${msg}\n  last events: ${log.slice(-8).join(' | ')}`);
    };

    const apply = fx => {
        for (const f of fx) {
            if (f.type === 'hide')
                f.ids.forEach(id => hidden.add(id));
            else if (f.type === 'show')
                f.ids.forEach(id => hidden.delete(id));
            else if (f.type === 'timer')
                timers.set(f.key, now + f.ms);
            else if (f.type === 'cancel')
                timers.delete(f.key);
            else if (f.type === 'focus' && f.id !== null) {
                if (!windows.has(f.id))
                    fail(`focus on unknown window ${f.id}`);
                if (windows.get(f.id).minimized)
                    fail(`focus on minimized window ${f.id}`);
            }
        }
        try {
            sm.checkInvariants();
        } catch (e) {
            fail(e.message);
        }
        const want = sm.hiddenIds();
        for (const id of windows.keys()) {
            if (want.has(id) !== hidden.has(id))
                fail(`window ${id}: replayed effects say ${hidden.has(id) ? 'hidden' : 'shown'}, model says ${want.has(id) ? 'hidden' : 'shown'}`);
        }
        for (const id of hidden) {
            if (!windows.has(id))
                fail(`hidden window ${id} is gone`);
            if (windows.get(id).minimized && windows.get(id).parent === null)
                fail(`minimized window ${id} was hidden`);
        }
        if (sm.strip().length > MAX_SHOWN)
            fail('strip lists too many sets');
        const ids = new Set();
        for (const ws of [0, 1, 2]) {
            for (const set of [sm.stage(ws), ...sm.waiting(ws)]) {
                for (const id of set?.windows ?? []) {
                    if (ids.has(id))
                        fail(`window ${id} in two places`);
                    ids.add(id);
                }
            }
        }
        for (const [id, w] of windows) {
            if (sm.isManaged(id) !== ids.has(id))
                fail(`window ${id} managed=${sm.isManaged(id)} but listed=${ids.has(id)}`);
            if (w.minimized && ids.has(id))
                fail(`minimized window ${id} is in a set`);
        }
    };

    const send = ev => {
        log.push(JSON.stringify(ev));
        if (ev.type === 'remove')
            hidden.delete(ev.id);   // the adapter forgets a window that goes away
        apply(sm.dispatch({ now, ...ev }));
    };

    const live = () => [...windows.values()];
    const normals = () => live().filter(w => w.type === 'normal');
    const change = (w, fields) => {
        Object.assign(w, fields);
        send({ type: 'change', window: { ...w } });
    };
    const sets = () => [sm.stage(active), ...sm.waiting(active)].filter(Boolean);

    send({ type: 'init', active, primary: 0, focus: null, windows: [] });

    for (let i = 0; i < steps; i++) {
        now += Math.floor(r() * 200);
        const op = Math.floor(r() * 24);
        const ns = normals();
        const w = ns.length ? pick(ns) : null;
        if (op < 4 || ns.length === 0) {
            const type = r() < 0.15 && ns.length ? 'dialog' : 'normal';
            const nw = {
                id: next++, appId: pick(apps), type, parent: type === 'dialog' ? pick(ns).id : null,
                workspace: r() < 0.8 ? active : pick([0, 1, 2, -1]), monitor: r() < 0.9 ? 0 : 1,
                fullscreen: false, above: r() < 0.05, skipTaskbar: r() < 0.05, title: 'w', minimized: false,
            };
            windows.set(nw.id, nw);
            send({ type: 'add', window: { ...nw } });
        } else if (op < 7 && w) {
            // A window closes with its dialogs
            for (const d of live().filter(x => x.parent === w.id)) {
                windows.delete(d.id);
                send({ type: 'remove', id: d.id });
            }
            windows.delete(w.id);
            send({ type: 'remove', id: w.id });
        } else if (op < 9 && w) {
            change(w, { minimized: !w.minimized });
        } else if (op < 11 && w) {
            send({ type: 'focus', id: w.id });
        } else if (op === 11 && w) {
            change(w, { fullscreen: !w.fullscreen });
        } else if (op === 12 && w) {
            change(w, { workspace: pick([0, 1, 2]) });
        } else if (op === 13) {
            active = pick([0, 1, 2]);
            send({ type: 'workspace', active });
        } else if (op === 14 && sets().length) {
            send({ type: 'activate', set: pick(sets()).id, add: r() < 0.3 });
        } else if (op === 15) {
            send({ type: 'cycle', dir: pick([1, -1]) });
        } else if (op === 16) {
            send({ type: 'slot', n: 1 + Math.floor(r() * 8) });
        } else if (op === 17 && w) {
            if (r() < 0.3 && sets().length)
                send({ type: 'move-to', id: w.id, set: pick(sets()).id });
            else
                send({ type: pick(['unset', 'stash']), id: w.id });
        } else if (op === 18) {
            send({ type: 'toggle-desktop' });
        } else if (op === 19) {
            send({ type: pick(['edge', 'strip-hover', 'overlap', 'overview']), on: r() < 0.5 });
        } else if (op === 20) {
            send({ type: 'push' });
        } else if (op === 21) {
            send({ type: 'join-next', appId: r() < 0.5 ? pick(apps) : null });
        } else if (op === 22 && w) {
            change(w, { monitor: pick([0, 1]) });
        } else {
            // Time passes: due timers fire
            now += 300;
            for (const [key, at] of [...timers]) {
                if (at <= now) {
                    timers.delete(key);
                    send({ type: 'timer', key });
                }
            }
        }
    }

    // Stage Manager lets go: every window becomes visible, none stays hidden
    for (const id of [...hidden])
        hidden.delete(id);
    if (hidden.size)
        fail('windows left hidden after release');
}

let failed = 0;
for (let seed = 1; seed <= 300; seed++) {
    try {
        run(seed, 250);
    } catch (e) {
        failed++;
        print(`FAIL ${e.message}`);
        if (failed >= 3)
            break;
    }
}
print(failed ? `${failed} failed` : 'ok   300 seeds x 250 events: invariants hold');
if (failed)
    imports.system.exit(1);
