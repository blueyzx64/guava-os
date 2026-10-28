// Run: gjs -m tests/notchStateMachine.test.js
import {
    initialState, step, view, nextDeadline, wantsBar, recentNotifications, URGENCY, SIZES, DEFAULT_CONFIG,
} from '../features/notch/stateMachine.js';

let failed = 0;
function test(name, fn) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function eq(a, b) {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Drive a sequence of events; returns {state, effects} (effects of the last event).
function run(events, cfg, start = initialState(0)) {
    let state = start;
    let effects = [];
    for (const ev of events)
        ({ state, effects } = step(state, ev, cfg));
    return { state, effects };
}
const notify = (id, now, extra = {}) => ({ type: 'notify', id, now, urgency: URGENCY.NORMAL, ...extra });
const tick = now => ({ type: 'tick', now });
const kind = s => view(s).kind;

test('idle by default, no deadline, no bar hold', () => {
    const s = initialState(0);
    eq(kind(s), 'idle');
    eq(view(s).size, SIZES.idle);
    eq(nextDeadline(s), null);
    eq(wantsBar(s), false);
});

test('normal notification expands, times out after normalMs', () => {
    let { state } = run([notify('a', 100)]);
    eq(view(state).kind, 'expanded');
    eq(view(state).content, 'notification');
    eq(view(state).size, SIZES.notification);
    eq(nextDeadline(state), 100 + DEFAULT_CONFIG.normalMs);
    eq(wantsBar(state), true);
    ({ state } = step(state, tick(100 + DEFAULT_CONFIG.normalMs - 1)));
    eq(kind(state), 'expanded');
    ({ state } = step(state, tick(100 + DEFAULT_CONFIG.normalMs)));
    eq(kind(state), 'idle');
});

test('high urgency lasts highMs, critical is sticky', () => {
    let { state } = run([notify('h', 0, { urgency: URGENCY.HIGH })]);
    eq(nextDeadline(state), DEFAULT_CONFIG.highMs);
    ({ state } = run([notify('c', 0, { urgency: URGENCY.CRITICAL }), tick(1e9)]));
    eq(kind(state), 'expanded');
    eq(nextDeadline(state), null);
});

test('low urgency and feedback notifications are compact', () => {
    let { state } = run([notify('l', 0, { urgency: URGENCY.LOW })]);
    eq(kind(state), 'compact');
    eq(nextDeadline(state), DEFAULT_CONFIG.compactMs);
    ({ state } = run([notify('f', 0, { forFeedback: true })]));
    eq(kind(state), 'compact');
});

test('newer notification replaces the one shown; the old one is the badge', () => {
    const { state } = run([notify('a', 0), notify('b', 1000)]);
    eq(view(state).notificationId, 'b');
    eq(view(state).badge, 1);
});

test('lower urgency arrival queues behind the current one', () => {
    const { state } = run([notify('a', 0, { urgency: URGENCY.HIGH }), notify('b', 10)]);
    eq(view(state).notificationId, 'a');
    eq(view(state).badge, 1);
});

test('queue plays by urgency then newest first, after the current one ends', () => {
    let { state } = run([
        notify('cur', 0, { urgency: URGENCY.HIGH }),
        notify('n1', 1), notify('n2', 2), notify('hi', 3, { urgency: URGENCY.HIGH }),
    ]);
    // hi (same urgency as cur) replaced it, cur went back to the queue
    eq(view(state).notificationId, 'hi');
    eq(state.pending.map(n => n.id), ['cur', 'n2', 'n1']);
    ({ state } = step(state, tick(DEFAULT_CONFIG.highMs + 3)));
    eq(view(state).notificationId, 'cur');
    eq(view(state).badge, 2);
});

test('update with the same id refreshes in place, no badge', () => {
    const { state } = run([notify('a', 0), notify('a', 2000)]);
    eq(view(state).badge, 0);
    eq(nextDeadline(state), 2000 + DEFAULT_CONFIG.normalMs);
});

test('hover freezes the timer; leaving keeps at least the grace time', () => {
    let { state } = run([notify('a', 0), { type: 'hover', value: true, now: 4000 }]);
    eq(nextDeadline(state), null);
    ({ state } = step(state, tick(60000)));
    eq(kind(state), 'expanded');
    ({ state } = step(state, { type: 'hover', value: false, now: 60000 }));
    eq(nextDeadline(state), 60000 + DEFAULT_CONFIG.hoverGraceMs);
    ({ state } = step(state, tick(60000 + DEFAULT_CONFIG.hoverGraceMs)));
    eq(kind(state), 'idle');
});

test('leaving hover keeps the remaining time when it is longer than the grace', () => {
    const { state } = run([notify('a', 0), { type: 'hover', value: true, now: 500 },
        { type: 'hover', value: false, now: 1000 }]);
    eq(nextDeadline(state), 1000 + 4500);
});

test('a hovered card is not replaced by a newer normal notification', () => {
    const { state } = run([notify('a', 0), { type: 'hover', value: true, now: 10 }, notify('b', 20)]);
    eq(view(state).notificationId, 'a');
    eq(view(state).badge, 1);
});

test('critical replaces even a hovered card', () => {
    const { state } = run([notify('a', 0), { type: 'hover', value: true, now: 10 },
        notify('c', 20, { urgency: URGENCY.CRITICAL })]);
    eq(view(state).notificationId, 'c');
});

test('DnD drops non-critical, keeps critical, activities still show', () => {
    let { state } = run([{ type: 'set', patch: { dnd: true }, now: 0 }, notify('a', 1)]);
    eq(kind(state), 'idle');
    ({ state } = step(state, notify('c', 2, { urgency: URGENCY.CRITICAL })));
    eq(kind(state), 'expanded');
    ({ state } = run([{ type: 'set', patch: { dnd: true }, now: 0 },
        { type: 'activity', key: 'media', data: { title: 't' }, now: 1 }]));
    eq(kind(state), 'live-activity');
});

test('turning DnD on clears the waiting non-critical notifications', () => {
    const { state } = run([notify('a', 0), notify('b', 1, { urgency: URGENCY.LOW }),
        { type: 'set', patch: { dnd: true }, now: 5 }]);
    eq(state.pending.length, 0);
});

test('fullscreen: only feedback (compact) and critical get through', () => {
    let { state } = run([{ type: 'set', patch: { fullscreen: true }, now: 0 }, notify('a', 1)]);
    eq(kind(state), 'idle');
    ({ state } = step(state, notify('f', 2, { forFeedback: true })));
    eq(kind(state), 'compact');
    ({ state } = step(state, notify('c', 3, { urgency: URGENCY.CRITICAL })));
    eq(view(state).kind, 'expanded');
    eq(view(state).notificationId, 'c');
});

test('osd preempts a card and everything resumes with the time they had left', () => {
    let { state } = run([notify('a', 0), { type: 'osd', kind: 'volume', level: 0.5, now: 2000 }]);
    eq(kind(state), 'osd');
    eq(nextDeadline(state), 2000 + DEFAULT_CONFIG.osdMs);
    ({ state } = step(state, tick(2000 + DEFAULT_CONFIG.osdMs)));
    eq(view(state).notificationId, 'a');
    // 5000 limit + 1500 spent behind the osd
    eq(nextDeadline(state), DEFAULT_CONFIG.normalMs + DEFAULT_CONFIG.osdMs);
});

test('osd refresh while held extends the osd but pauses underneath only once', () => {
    let { state } = run([notify('a', 0), { type: 'osd', kind: 'volume', level: 0.1, now: 1000 },
        { type: 'osd', kind: 'volume', level: 0.2, now: 2000 }]);
    eq(view(state).osd.level, 0.2);
    eq(nextDeadline(state), 3500);
    ({ state } = step(state, tick(3500)));
    // paused from 1000 to 3500
    eq(nextDeadline(state), 5000 + 2500);
});

test('osd over a critical card still shows, then the card returns', () => {
    let { state } = run([notify('c', 0, { urgency: URGENCY.CRITICAL }), { type: 'osd', kind: 'volume', now: 10 }]);
    eq(kind(state), 'osd');
    ({ state } = step(state, tick(10 + DEFAULT_CONFIG.osdMs)));
    eq(view(state).notificationId, 'c');
});

test('osd over a live activity returns to it', () => {
    let { state } = run([{ type: 'activity', key: 'media', data: { t: 1 }, now: 0 },
        { type: 'osd', kind: 'brightness', now: 5 }]);
    eq(kind(state), 'osd');
    ({ state } = step(state, tick(5 + DEFAULT_CONFIG.osdMs)));
    eq(kind(state), 'live-activity');
});

test('osd off in config: ignored', () => {
    const { state } = run([{ type: 'osd', kind: 'volume', now: 0 }], { osd: false });
    eq(kind(state), 'idle');
});

test('live activity: highest priority then latest wins; removal falls back', () => {
    let { state } = run([
        { type: 'activity', key: 'media', priority: 0, data: { n: 'm' }, now: 0 },
        { type: 'activity', key: 'timer', priority: 5, data: { n: 't' }, now: 1 },
        { type: 'activity', key: 'rec', priority: 5, data: { n: 'r' }, now: 2 },
    ]);
    eq(view(state).activity.key, 'rec');
    ({ state } = step(state, { type: 'activity', key: 'rec', data: null, now: 3 }));
    eq(view(state).activity.key, 'timer');
    ({ state } = step(state, { type: 'activity', key: 'timer', data: null, now: 4 }));
    eq(view(state).activity.key, 'media');
});

test('activity update keeps its place in the order', () => {
    const { state } = run([
        { type: 'activity', key: 'a', data: 1, now: 0 },
        { type: 'activity', key: 'b', data: 1, now: 1 },
        { type: 'activity', key: 'a', data: 2, now: 2 },
    ]);
    eq(view(state).activity.key, 'b');
    eq(view(state).activity.data, 1);
});

test('live activity alone does not hold the bar; a notification over it does', () => {
    let { state } = run([{ type: 'activity', key: 'media', data: 1, now: 0 }]);
    eq(wantsBar(state), false);
    ({ state } = step(state, notify('a', 1)));
    eq(wantsBar(state), true);
});

test('click on a card activates it and moves on to the queue', () => {
    let { state, effects } = run([notify('a', 0), notify('b', 1, { urgency: URGENCY.LOW })]);
    eq(view(state).notificationId, 'a');
    ({ state, effects } = step(state, { type: 'click', now: 5 }));
    eq(effects, [{ type: 'activate', id: 'a' }]);
    eq(view(state).notificationId, 'b');
});

test('dismiss emits a dismiss effect', () => {
    const { state, effects } = run([notify('a', 0), { type: 'dismiss', now: 5 }]);
    eq(effects, [{ type: 'dismiss', id: 'a' }]);
    eq(kind(state), 'idle');
});

test('click on idle opens the dashboard; click again closes it', () => {
    let { state } = run([{ type: 'click', now: 0 }]);
    eq(view(state).content, 'dashboard');
    eq(view(state).size, SIZES.dashboard);
    ({ state } = step(state, { type: 'click', now: 10 }));
    eq(kind(state), 'idle');
});

test('dashboard closes after the pointer has left for dashboardLeaveMs', () => {
    let { state } = run([{ type: 'hover', value: true, now: 0 }, { type: 'click', now: 1 }]);
    eq(nextDeadline(state), null);
    ({ state } = step(state, { type: 'hover', value: false, now: 100 }));
    eq(nextDeadline(state), 100 + DEFAULT_CONFIG.dashboardLeaveMs);
    ({ state } = step(state, tick(100 + DEFAULT_CONFIG.dashboardLeaveMs)));
    eq(kind(state), 'idle');
});

test('a normal notification waits while the dashboard is open, critical does not', () => {
    let { state } = run([{ type: 'click', now: 0 }, notify('a', 1)]);
    eq(view(state).content, 'dashboard');
    eq(view(state).badge, 1);
    ({ state } = step(state, notify('c', 2, { urgency: URGENCY.CRITICAL })));
    eq(view(state).notificationId, 'c');
    ({ state } = step(state, { type: 'click', now: 3 })); // activates the critical one
    eq(view(state).content, 'dashboard');
    ({ state } = step(state, { type: 'click', now: 4 })); // closes the dashboard
    eq(view(state).notificationId, 'a');
});

test('notify-removed drops it from screen and from the queue', () => {
    let { state } = run([notify('a', 0), notify('b', 1, { urgency: URGENCY.LOW }), { type: 'notify-removed', id: 'b', now: 2 }]);
    eq(view(state).badge, 0);
    ({ state } = step(state, { type: 'notify-removed', id: 'a', now: 3 }));
    eq(kind(state), 'idle');
});

test('queue is capped at maxPending, lowest and oldest dropped', () => {
    const events = [notify('cur', 0, { urgency: URGENCY.HIGH })];
    for (let i = 1; i <= 12; i++)
        events.push(notify(`n${i}`, i));
    const { state } = run(events, { maxPending: 3 });
    eq(state.pending.length, 3);
    eq(state.pending.map(n => n.id), ['n12', 'n11', 'n10']);
});

test('notifications disabled in config: ignored, and a config change clears the screen', () => {
    let { state } = run([notify('a', 0)], { notifications: false });
    eq(kind(state), 'idle');
    ({ state } = run([notify('a', 0)]));
    ({ state } = step(state, { type: 'set', patch: {}, now: 1 }, { notifications: false }));
    eq(kind(state), 'idle');
});

test('activities disabled in config: ignored', () => {
    const { state } = run([{ type: 'activity', key: 'm', data: 1, now: 0 }], { activities: false });
    eq(kind(state), 'idle');
});

test('time never goes backwards', () => {
    const { state } = run([tick(1000), tick(500)]);
    eq(state.now, 1000);
});

test('step does not mutate its input', () => {
    const s0 = initialState(0);
    const frozen = JSON.stringify(s0);
    step(s0, notify('a', 0));
    step(s0, { type: 'activity', key: 'k', data: 1, now: 0 });
    eq(JSON.stringify(s0), frozen);
});

test('confirm ("Copied") shows like an osd without a level and then goes away', () => {
    let { state } = run([{ type: 'confirm', kind: 'copied', label: 'Copied', now: 0 }]);
    eq(kind(state), 'osd');
    eq(view(state).osd.kind, 'copied');
    eq(view(state).osd.level, null);
    eq(nextDeadline(state), DEFAULT_CONFIG.osdMs);
    ({ state } = step(state, tick(DEFAULT_CONFIG.osdMs)));
    eq(kind(state), 'idle');
});

test('confirm preempts a card, which resumes afterwards; off with the osd setting', () => {
    let { state } = run([notify('a', 0), { type: 'confirm', kind: 'copied', now: 100 }]);
    eq(kind(state), 'osd');
    ({ state } = step(state, tick(100 + DEFAULT_CONFIG.osdMs)));
    eq(view(state).notificationId, 'a');
    ({ state } = run([{ type: 'confirm', kind: 'copied', now: 0 }], { osd: false }));
    eq(kind(state), 'idle');
});

test('the queue cap never drops a critical notification', () => {
    const events = [notify('cur', 0, { urgency: URGENCY.CRITICAL })];
    for (let i = 1; i <= 4; i++)
        events.push(notify(`c${i}`, i, { urgency: URGENCY.CRITICAL }));
    events.push(notify('n', 10));
    // cur is hovered-free critical; newer criticals replace it, all go to the queue
    const { state } = run(events, { maxPending: 2 });
    const ids = [state.current.id, ...state.pending.map(n => n.id)];
    for (const id of ['cur', 'c1', 'c2', 'c3', 'c4'])
        if (!ids.includes(id))
            throw new Error(`critical ${id} dropped: ${ids}`);
    eq(ids.includes('n'), false);
});

test('the queue cap drops non-critical first, keeping criticals', () => {
    const { state } = run([
        notify('a', 0, { urgency: URGENCY.HIGH }),
        notify('c', 1, { urgency: URGENCY.CRITICAL }),
        notify('n1', 2), notify('n2', 3),
    ], { maxPending: 1 });
    eq(state.current.id, 'c');
    eq(state.pending.map(n => n.id), ['a']);
});

test('osd pause only counts the part that covered the card', () => {
    // osd 0..1500, the card arrives at 1000 under it: 500 ms of overlap
    let { state } = run([{ type: 'osd', kind: 'volume', now: 0 }, notify('a', 1000)]);
    ({ state } = step(state, tick(DEFAULT_CONFIG.osdMs)));
    eq(view(state).notificationId, 'a');
    eq(nextDeadline(state), 1000 + DEFAULT_CONFIG.normalMs + 500);
});

test('osd pause on the dashboard only counts from when it opened', () => {
    let { state } = run([{ type: 'osd', kind: 'volume', now: 0 }, { type: 'click', now: 1200 }]);
    // click during the osd is ignored, so open after it
    ({ state } = step(state, tick(DEFAULT_CONFIG.osdMs)));
    ({ state } = step(state, { type: 'click', now: 1600 }));
    ({ state } = step(state, { type: 'osd', kind: 'volume', now: 2000 }));
    ({ state } = step(state, tick(2000 + DEFAULT_CONFIG.osdMs)));
    eq(nextDeadline(state), 1600 + DEFAULT_CONFIG.dashboardLeaveMs + DEFAULT_CONFIG.osdMs);
});

test('collapse (outside press or Escape) closes the dashboard and shows what waited', () => {
    let { state } = run([{ type: 'click', now: 0 }, notify('a', 10)]);
    eq(view(state).content, 'dashboard');
    eq(state.pending.map(n => n.id), ['a']);
    ({ state } = step(state, { type: 'collapse', now: 20 }));
    eq(state.dashboard, null);
    eq(view(state).notificationId, 'a');
});

test('collapse leaves a notification card and idle alone', () => {
    let { state, effects } = run([notify('a', 0), { type: 'collapse', now: 5 }]);
    eq(view(state).notificationId, 'a');
    eq(effects, []);
    ({ state } = step(initialState(0), { type: 'collapse', now: 1 }));
    eq(kind(state), 'idle');
});

test('recentNotifications: newest first, capped, untimed last in given order', () => {
    const list = [
        { id: 1, time: 100 }, { id: 2, time: null }, { id: 3, time: 300 },
        { id: 4, time: 200 }, { id: 5 },
    ];
    eq(recentNotifications(list, 2).map(e => e.id), [3, 4]);
    eq(recentNotifications(list, 10).map(e => e.id), [3, 4, 1, 2, 5]);
    eq(recentNotifications(list, 0), []);
    eq(recentNotifications([], 3), []);
    eq(list.map(e => e.id), [1, 2, 3, 4, 5]); // input untouched
});

test('hover intent opens the dashboard; leaving closes it after hoverLeaveMs', () => {
    let { state } = run([{ type: 'hover', value: true, now: 0 }, { type: 'expand', now: 300 }]);
    eq(view(state).content, 'dashboard');
    eq(view(state).tab, 'now');
    eq(view(state).pinned, false);
    ({ state } = step(state, { type: 'hover', value: false, now: 1000 }));
    eq(nextDeadline(state), 1000 + DEFAULT_CONFIG.hoverLeaveMs);
    ({ state } = step(state, tick(1000 + DEFAULT_CONFIG.hoverLeaveMs)));
    eq(state.dashboard, null);
});
test('expand needs the pointer and never covers a card', () => {
    let { state } = run([{ type: 'expand', now: 1 }]);
    eq(state.dashboard, null, 'pointer already gone');
    ({ state } = run([{ type: 'notify', id: 1, urgency: URGENCY.NORMAL, now: 0 },
        { type: 'hover', value: true, now: 1 }, { type: 'expand', now: 2 }]));
    eq(view(state).content, 'notification');
});
test('a click pins a hover-opened dashboard; a second click closes it', () => {
    let { state } = run([{ type: 'hover', value: true, now: 0 }, { type: 'expand', now: 1 }, { type: 'click', now: 2 }]);
    eq(view(state).pinned, true);
    ({ state } = step(state, { type: 'hover', value: false, now: 3 }));
    eq(nextDeadline(state), 3 + DEFAULT_CONFIG.dashboardLeaveMs);
    ({ state } = step(state, { type: 'click', now: 4 }));
    eq(state.dashboard, null);
});
test('tabs switch only while the dashboard is open', () => {
    let { state } = run([{ type: 'click', now: 0 }, { type: 'tab', tab: 'tray', now: 1 }]);
    eq(view(state).tab, 'tray');
    ({ state } = step(state, { type: 'tab', tab: 'bogus', now: 2 }));
    eq(view(state).tab, 'tray');
    ({ state } = step(state, { type: 'click', now: 3 }));
    ({ state } = step(state, { type: 'tab', tab: 'widgets', now: 4 }));
    eq(state.dashboard, null);
});
test('kinds: an alert preempts, expires on a tick, and the pill widens for a code', () => {
    let { state } = run([{ type: 'activity', key: 'media', kind: 'media', data: { t: 1 }, now: 0 },
        { type: 'activity', key: 'code', kind: 'code', data: { code: '1234' }, now: 10 }]);
    eq(view(state).activity.key, 'code');
    eq(view(state).size.w, 300);
    eq(nextDeadline(state), 30010);
    ({ state } = step(state, tick(30010)));
    eq(view(state).activity.key, 'media');
    eq(state.activities.length, 1);
    eq(nextDeadline(state), null);
});
test('kinds: an update keeps the alert clock, fresh restarts it; quiet kinds stay off the pill', () => {
    let { state } = run([{ type: 'activity', key: 'c', kind: 'charging-started', data: 1, now: 0 },
        { type: 'activity', key: 'c', kind: 'charging-started', data: 2, now: 3000 }]);
    eq(nextDeadline(state), 4000);
    ({ state } = step(state, { type: 'activity', key: 'c', kind: 'charging-started', data: 3, fresh: true, now: 3500 }));
    eq(nextDeadline(state), 7500);
    ({ state } = run([{ type: 'activity', key: 'b', kind: 'charging', data: 1, now: 0 }]));
    eq(view(state).kind, 'idle');
    ({ state } = step(state, { type: 'click', now: 1 }));
    eq(view(state).activities.map(a => a.key), ['b']);
});

test('a file drag over the notch opens the Tray and holds it; a drop keeps it a little longer', () => {
    let { state } = run([{ type: 'drag-over', value: true, now: 0 }]);
    eq(view(state).tab, 'tray');
    eq(view(state).dropping, true);
    eq(nextDeadline(state), null);
    ({ state } = step(state, { type: 'drag-over', value: false, dropped: true, now: 100 }));
    eq(nextDeadline(state), 100 + DEFAULT_CONFIG.dashboardLeaveMs);
    ({ state } = run([{ type: 'click', now: 0 }, { type: 'drag-over', value: true, now: 1 },
        { type: 'drag-over', value: false, now: 2 }]));
    eq(view(state).tab, 'tray', 'an open dashboard switches to the Tray');
    eq(nextDeadline(state), 2 + DEFAULT_CONFIG.hoverLeaveMs);
});

print(failed ? `${failed} FAILED` : 'all passed');
if (failed)
    imports.system.exit(1);
