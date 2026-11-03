// Run: gjs -m tests/mprisModel.test.js
import {
    hasTrack, pickPlayer, showsActivity, NO_TRACK_ID, WEBKIT_TRACK_ID, trackKey, normalizeArtists,
    normalizeTitle, normalizeCover, normalizeLength, clampSeekTarget, seekMethod, canNavigate,
} from '../lib/mprisModel.js';

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

test('hasTrack: Rhythmbox at startup (empty Metadata, Stopped) has none', () => {
    eq(hasTrack({}, 'Stopped'), false);
    eq(hasTrack(undefined, 'Stopped'), false);
    eq(hasTrack({ trackId: '/org/mpris/MediaPlayer2/Track/3' }, 'Stopped'), false);
    eq(hasTrack({ trackId: NO_TRACK_ID }, 'Stopped'), false);
});

test('hasTrack: details or playing / paused count', () => {
    eq(hasTrack({ title: 'A' }, 'Stopped'), true);
    eq(hasTrack({ url: 'file:///a.flac' }, 'Stopped'), true);
    eq(hasTrack({ length: 34_000_000 }, undefined), true);
    eq(hasTrack({ length: 0 }, 'Stopped'), false);
    eq(hasTrack({}, 'Playing'), true);
    eq(hasTrack({ trackId: NO_TRACK_ID }, 'Paused'), true); // Decibels with loaded audio
});

test('pickPlayer: playing beats paused beats stopped', () => {
    eq(pickPlayer([
        { status: 'Stopped', since: 9, item: 'a' },
        { status: 'Paused', since: 5, item: 'b' },
        { status: 'Playing', since: 1, item: 'c' },
    ]), 'c');
    eq(pickPlayer([
        { status: 'Stopped', since: 9, item: 'a' },
        { status: 'Paused', since: 0, item: 'b' },
    ]), 'b');
});

test('pickPlayer: the one that started playing last wins a tie', () => {
    eq(pickPlayer([
        { status: 'Playing', since: 10, item: 'rb' },
        { status: 'Playing', since: 20, item: 'x2' },
    ]), 'x2');
    eq(pickPlayer([
        { status: 'Paused', since: 30, item: 'rb' },
        { status: 'Paused', since: 20, item: 'x2' },
    ]), 'rb');
});

test('pickPlayer: given order breaks a full tie; empty is null', () => {
    eq(pickPlayer([
        { status: 'Stopped', since: undefined, item: 'a' },
        { status: 'Stopped', since: undefined, item: 'b' },
    ]), 'a');
    eq(pickPlayer([]), null);
    eq(pickPlayer(null), null);
});

test('showsActivity: playing and paused only', () => {
    eq(showsActivity('Playing'), true);
    eq(showsActivity('Paused'), true);
    eq(showsActivity('Stopped'), false);
    eq(showsActivity(undefined), false);
});

test('trackKey: null when idle, distinguishes tracks that reuse an id', () => {
    eq(trackKey({ trackId: 'a' }, false), null);
    const a = trackKey({ trackId: '/x', title: 'One', artists: ['A'] }, true);
    const b = trackKey({ trackId: '/x', title: 'Two', artists: ['A'] }, true);
    if (a === b || a === null)
        throw new Error('keys should differ');
    eq(trackKey({ title: 'One' }, true), trackKey({ title: 'One' }, true));
});

test('normalize: artists, title, cover, length', () => {
    eq(normalizeArtists('Solo', '?'), ['Solo']);
    eq(normalizeArtists(['A', 'B'], '?'), ['A', 'B']);
    eq(normalizeArtists([1, 2], '?'), ['?']);
    eq(normalizeArtists(undefined, '?'), ['?']);
    eq(normalizeArtists([], '?'), ['?']);
    eq(normalizeTitle(5, 'T'), 'T');
    eq(normalizeTitle('x', 'T'), 'x');
    eq(normalizeCover('file:///a.png'), 'file:///a.png');
    eq(normalizeCover(3), null);
    eq(normalizeLength(0), null);
    eq(normalizeLength(NaN), null);
    eq(normalizeLength(5e6), 5e6);
});

test('clampSeekTarget: clamps, rounds, rejects non-finite', () => {
    eq(clampSeekTarget(-5, 100), 0);
    eq(clampSeekTarget(500, 100), 100);
    eq(clampSeekTarget(500, null), 500);
    eq(clampSeekTarget(10.6, 100), 11);
    eq(clampSeekTarget(NaN, 100), null);
    eq(clampSeekTarget(Infinity, 100), null);
    eq(clampSeekTarget('3', 100), null);
});

test('seekMethod: per player kind', () => {
    eq(seekMethod(WEBKIT_TRACK_ID), 'seek-absolute');
    eq(seekMethod('/org/x/Track/1'), 'set-position');
    eq(seekMethod(NO_TRACK_ID), 'seek-relative');
    eq(seekMethod(''), 'seek-relative');
    eq(seekMethod(undefined), 'seek-relative');
});

test('canNavigate: needs control, a track and the capability; never WebKit', () => {
    eq(canNavigate({ control: true, loaded: true, trackId: '/a', can: true }), true);
    eq(canNavigate({ control: false, loaded: true, trackId: '/a', can: true }), false);
    eq(canNavigate({ control: true, loaded: false, trackId: '/a', can: true }), false);
    eq(canNavigate({ control: true, loaded: true, trackId: WEBKIT_TRACK_ID, can: true }), false);
    eq(canNavigate({ control: true, loaded: true, trackId: '/a', can: false }), false);
});

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
