// Run: gjs -m tests/notchDownloadsModel.test.js
// features/notch/downloadsModel.js: which downloads the notch shows, and when they go (B8).
import { DownloadTracker, STALE_MS } from '../src/features/notch/downloadsModel.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const CHROME = 'application://google-chrome.desktop';
const bar = (progress, visible = true) => ({ 'progress': progress, 'progress-visible': visible });

test('a progress bar shows; progress-visible false hides it', () => {
    const t = new DownloadTracker();
    eq(t.appUpdate(':1.4', CHROME, bar(0.25), 0), true);
    eq(t.summary(), { label: 'google-chrome', fraction: 0.25, bytes: null, count: 1 });
    eq(t.appUpdate(':1.4', CHROME, { 'progress-visible': false }, 10), true);
    eq(t.summary(), null);
});

test('updates merge: progress alone after a hide stays hidden; a count alone changes nothing', () => {
    const t = new DownloadTracker();
    t.appUpdate(':1.4', CHROME, bar(0.5, false), 0);
    t.appUpdate(':1.4', CHROME, { 'progress': 0.6 }, 1);
    eq(t.summary(), null);
    t.appUpdate(':1.4', CHROME, { 'progress-visible': true }, 2);
    eq(t.summary().fraction, 0.6);
    eq(t.appUpdate(':1.4', CHROME, { 'count': 3, 'count-visible': true }, 3), false);
});

test('the sender leaving the bus (browser closed or crashed) drops its bar', () => {
    const t = new DownloadTracker();
    t.appUpdate(':1.4', CHROME, bar(0.4), 0);
    t.appUpdate(':1.9', 'application://org.gnome.Nautilus.desktop', bar(0.1), 0);
    eq(t.senders(), [':1.4', ':1.9']);
    eq(t.senderGone(':1.4'), true);
    eq(t.summary().label, 'org.gnome.Nautilus');
    eq(t.senderGone(':1.4'), false);
    eq(t.senders(), [':1.9']);
});

test('a bar that stops moving for STALE_MS is dropped (cancelled but never hidden); moving again brings it back', () => {
    const t = new DownloadTracker();
    t.appUpdate(':1.4', CHROME, bar(0.4), 0);
    t.appUpdate(':1.4', CHROME, bar(0.4), STALE_MS - 1);   // same value: not progress
    eq(t.nextExpiry(), STALE_MS);
    eq(t.prune(STALE_MS - 1), false);
    eq(t.prune(STALE_MS), true);
    eq(t.summary(), null);
    eq(t.nextExpiry(), null);
    t.appUpdate(':1.4', CHROME, { 'progress': 0.45 }, STALE_MS + 5);
    eq(t.summary().fraction, 0.45);
    eq(t.nextExpiry(), STALE_MS + 5 + STALE_MS);
});

test('a partial file shows while it grows and goes when it stops growing', () => {
    const t = new DownloadTracker();
    eq(t.partialSeen('iso.img.part', 0, 0), true);
    eq(t.livePartials(), ['iso.img.part']);
    eq(t.partialSize('iso.img.part', 1000, 1000), true);
    eq(t.partialSize('iso.img.part', 1000, 2000), false);
    eq(t.summary(), { label: 'iso.img', fraction: null, bytes: 1000, count: 1 });
    eq(t.prune(1000 + STALE_MS), true);
    eq(t.summary(), null);
    eq(t.livePartials(), [], 'no more size polling for a dormant file');
    // It is written to again (a paused download resumed)
    eq(t.partialSeen('iso.img.part', 5000, 1000 + STALE_MS + 10), true);
    eq(t.summary().bytes, 5000);
});

test('old partial files found at login (an interrupted download weeks ago) never show', () => {
    const t = new DownloadTracker();
    eq(t.partialSeen('Unconfirmed 1234.crdownload', 9000, 100, 21 * 24 * 3600 * 1000), false);
    eq(t.summary(), null);
    eq(t.livePartials(), []);
    eq(t.partialSeen('fresh.part', 10, 100, 2000), true);
    eq(t.summary().label, 'fresh');
    eq(t.nextExpiry(), 100 - 2000 + STALE_MS);
});

test('a partial file removed or renamed goes; the tracker says if it knew it', () => {
    const t = new DownloadTracker();
    t.partialSeen('a.part', 1, 0);
    t.partialSeen('old.part', 1, 0, STALE_MS * 2);
    eq(t.partialGone('a.part'), true);
    eq(t.partialGone('old.part'), true, 'a dormant one counts (renamed = finished)');
    eq(t.partialGone('nope.part'), false);
    eq(t.summary(), null);
});

test('clear forgets everything', () => {
    const t = new DownloadTracker();
    t.appUpdate(':1.4', CHROME, bar(0.4), 0);
    t.partialSeen('a.part', 1, 0);
    t.clear();
    eq([t.summary(), t.senders(), t.livePartials(), t.nextExpiry()], [null, [], [], null]);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
