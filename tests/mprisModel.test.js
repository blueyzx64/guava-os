// Run: gjs -m tests/mprisModel.test.js
import { hasTrack, pickPlayer, showsActivity, NO_TRACK_ID } from '../lib/mprisModel.js';

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

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
