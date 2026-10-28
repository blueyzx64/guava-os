// Run: gjs -m tests/stageManagerFuzz.test.js
// Fuzz test of the Stage Manager state machine: random window events (open, close, minimize,
// focus, workspace moves, full screen, maximize, dialogs, monitors) and user actions, with the
// model's invariants checked after every event, and the effects replayed on a fake desktop
// that must always agree with the model (no window left hidden or shown by mistake).
import { StageMachine } from '../features/stageManager/model.js';

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
    const config = { allAtOnce: r() < 0.6, newWindows: r() < 0.7 ? 'replace' : 'join' };
    const sm = new StageMachine(config);
    const windows = new Map();   // id -> description (the "desktop")
    const opacity = new Map();   // id -> 0 | 255: what the adapter would have applied
    const timers = new Map();
    let now = 0;
    let next = 1;
    let active = 0;
    const log = [];
    const apps = ['a', 'b', 'c', 'd'];

    const apply = (ev, fx) => {
        for (const f of fx) {
            if (f.type === 'hide')
                f.ids.forEach(id => opacity.set(id, 0));
            else if (f.type === 'show')
                f.ids.forEach(id => opacity.set(id, 255));
            else if (f.type === 'timer')
                timers.set(f.key, now + f.ms);
            else if (f.type === 'cancel')
                timers.delete(f.key);
            else if (f.type === 'unminimize' && windows.has(f.id))
                windows.get(f.id).minimized = false;
            else if (f.type === 'focus' && f.id !== null && !windows.has(f.id))
                throw new Error(`focus on unknown window ${f.id}`);
        }
        const bad = sm.checkInvariants();
        for (const f of fx) {
            if (f.type === 'focus' && f.id !== null && sm.isHidden(f.id))
                bad.push(`focus effect on hidden window ${f.id}`);
        }
        for (const id of windows.keys()) {
            const want = sm.isHidden(id) ? 0 : 255;
            if ((opacity.get(id) ?? 255) !== want)
                bad.push(`window ${id}: applied opacity ${opacity.get(id) ?? 255}, model wants ${want}`);
        }
        for (const id of opacity.keys()) {
            if (!windows.has(id))
                bad.push(`orphan opacity for closed window ${id}`);
        }
        if (bad.length)
            throw new Error(`seed ${seed} after #${log.length} ${JSON.stringify(ev)}: ${bad.join('; ')}\n${log.slice(-12).join('\n')}`);
    };
    const send = ev => {
        log.push(JSON.stringify(ev));
        const fx = sm.dispatch({ now, ...ev });
        apply(ev, fx);
        return fx;
    };
    const change = (id, fields) => {
        Object.assign(windows.get(id), fields);
        send({ type: 'change', window: { id, ...fields } });
    };
    const any = () => pick([...windows.keys()]);

    send({ type: 'init', windows: [], focus: null, active: 0, primary: 0 });
    for (let i = 0; i < steps; i++) {
        now += Math.floor(r() * 250);
        for (const [key, at] of [...timers]) {
            if (at <= now) {
                timers.delete(key);
                send({ type: 'timer', key });
            }
        }
        const roll = r();
        if (windows.size < 3 || roll < 0.16) {
            const parent = windows.size && r() < 0.25 ? any() : null;
            const w = {
                id: next++, appId: `${pick(apps)}.desktop`, type: parent && r() < 0.8 ? 'dialog' : 'normal',
                parent, workspace: r() < 0.9 ? active : pick([0, 1, -1]), monitor: r() < 0.92 ? 0 : 1,
                fullscreen: r() < 0.05, above: r() < 0.04, skipTaskbar: r() < 0.04,
                title: r() < 0.03 ? 'Picture-in-Picture' : 'w', minimized: false, flagged: r() < 0.03,
            };
            windows.set(w.id, w);
            send({ type: 'add', window: { ...w } });
        } else if (roll < 0.26) {
            const id = any();
            windows.delete(id);
            opacity.delete(id);
            send({ type: 'remove', id });
            // Mutter drops the transient-for link of children whose parent is gone
            for (const w of windows.values()) {
                if (w.parent === id)
                    change(w.id, { parent: null });
            }
        } else if (roll < 0.40) {
            send({ type: 'focus', id: any() });
        } else if (roll < 0.47) {
            const id = any();
            if (r() < 0.5)
                change(id, { minimized: true });
            else
                send({ type: 'minimize', id });
        } else if (roll < 0.52) {
            change(any(), { workspace: pick([0, 1, 2, -1]) });
        } else if (roll < 0.57) {
            const id = any();
            change(id, { fullscreen: !windows.get(id).fullscreen });
        } else if (roll < 0.60) {
            const id = any();
            const want = r() < 0.5;
            const rising = want && !windows.get(id).maximized;
            const entry = sm.entryOf(id);
            const staged = entry !== null && sm.stage(sm.entry(entry).ws) === entry;
            change(id, { maximized: want });
            // A maximized stage window of a set is alone on the stage; the rest are in the strip
            if (rising && staged && sm.entryOf(id) !== null && sm.entry(sm.entryOf(id)).windows.length !== 1)
                throw new Error(`seed ${seed}: maximized window ${id} still shares its entry`);
        } else if (roll < 0.63) {
            const id = any();
            change(id, { above: !windows.get(id).above });
        } else if (roll < 0.65) {
            change(any(), r() < 0.5 ? { monitor: r() < 0.7 ? 0 : 1 } : { flagged: r() < 0.5 });
        } else if (roll < 0.67) {
            const id = any();
            const others = [...windows.keys()].filter(x => x !== id);
            change(id, { parent: others.length && r() < 0.5 ? pick(others) : null });
        } else if (roll < 0.77) {
            const strip = sm.strip(active);
            if (strip.length)
                send({ type: 'activate', entry: pick(strip), add: r() < 0.35 });
        } else if (roll < 0.81) {
            send({ type: 'remove-from-set', id: any() });
        } else if (roll < 0.84) {
            const strip = sm.strip(active);
            if (strip.length)
                send({ type: 'move-to-entry', id: any(), entry: pick(strip) });
        } else if (roll < 0.865) {
            const strip = sm.strip(active);
            if (strip.length > 1) {
                const [dragged, target] = [pick(strip), pick(strip)];
                const fx = send({ type: 'group', dragged, target, side: r() < 0.5 ? 'left' : 'right' });
                const tile = fx.find(f => f.type === 'tile');
                if (tile && [...tile.left, ...tile.right].some(id => sm.isHidden(id) || sm.stage(active) !== sm.entryOf(id)))
                    throw new Error(`seed ${seed}: tiled window not on the stage`);
            }
        } else if (roll < 0.88) {
            send({ type: 'toggle-desktop' });
        } else if (roll < 0.91) {
            send({ type: 'cycle', dir: r() < 0.5 ? 1 : -1 });
        } else if (roll < 0.93) {
            send({ type: 'slot', n: 1 + Math.floor(r() * 6) });
        } else if (roll < 0.96) {
            active = pick([0, 1, 2]);
            send({ type: 'workspace', active });
        } else if (roll < 0.98) {
            send({ type: 'join-next', appId: r() < 0.5 ? null : `${pick(apps)}.desktop` });
        } else {
            send({ type: 'monitors', primary: r() < 0.8 ? 0 : 1 });
        }
    }
}

let failed = 0;
const SEEDS = 300;
const STEPS = 400;
for (let seed = 1; seed <= SEEDS; seed++) {
    try {
        run(seed, STEPS);
    } catch (e) {
        failed++;
        print(`FAIL ${e.message}`);
        if (failed > 3)
            break;
    }
}
print(failed ? `FAIL fuzz: ${failed} seed(s)` : `ok   fuzz: ${SEEDS} seeds x ${STEPS} events, invariants held`);
if (failed)
    imports.system.exit(1);
