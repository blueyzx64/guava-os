// Run: gjs -m tests/screenshotsModel.test.js
import {
    THUMBNAIL_MS, THUMBNAIL_BOX, ThumbnailLife, commitPlan, countdown, defaultSelection, destinationFor,
    extensionOf, isCapturableArea, modeFrom, modeSpec, nameCandidates, normalizeDestination,
    normalizeTimer, selectionFromList, selectionToList, spaceToggle, stampedName, startSelection,
    swipeOffset, swipeOutcome, thumbnailEntryOffset, thumbnailRest, thumbnailSize, MODES,
} from '../features/screenshots/model.js';

let failed = 0;
function test(name, fn) {
    try { fn(); print(`ok   ${name}`); } catch (e) { failed++; print(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb)
        throw new Error(`expected ${jb}, got ${ja}`);
}

const STAMP = { year: 2026, month: 3, day: 9, hour: 8, minute: 5, second: 7 };

test('stampedName: macOS pattern with zero padding', () => {
    eq(stampedName(STAMP), 'Screenshot 2026-03-09 at 08.05.07');
    eq(stampedName({ ...STAMP, hour: 23, minute: 59, second: 59 }), 'Screenshot 2026-03-09 at 23.59.59');
    eq(stampedName(STAMP, 'Screen Recording'), 'Screen Recording 2026-03-09 at 08.05.07');
});

test('nameCandidates: plain name, then (2), (3)', () => {
    const it = nameCandidates('Screenshot 2026-03-09 at 08.05.07', 'png');
    eq([it.next().value, it.next().value, it.next().value],
        ['Screenshot 2026-03-09 at 08.05.07.png', 'Screenshot 2026-03-09 at 08.05.07 (2).png',
            'Screenshot 2026-03-09 at 08.05.07 (3).png']);
});

test('extensionOf', () => {
    eq(extensionOf('a.png'), 'png');
    eq(extensionOf('a.b.webm'), 'webm');
    eq(extensionOf('noext'), '');
    eq(extensionOf('.hidden'), '');
});

test('normalizeTimer / normalizeDestination: junk falls back', () => {
    eq([0, 5, 10].map(normalizeTimer), [0, 5, 10]);
    eq([normalizeTimer(7), normalizeTimer('5'), normalizeTimer(null)], [0, 0, 0]);
    eq(normalizeDestination('desktop'), 'desktop');
    eq(normalizeDestination('mail'), 'pictures');
});

const DIRS = { desktop: '/h/Desktop', documents: '/h/Documents' };

test('destinationFor: each choice', () => {
    eq(destinationFor({ saveTo: 'desktop', otherFolder: '' }, DIRS), { kind: 'folder', path: '/h/Desktop' });
    eq(destinationFor({ saveTo: 'documents', otherFolder: '' }, DIRS), { kind: 'folder', path: '/h/Documents' });
    eq(destinationFor({ saveTo: 'clipboard', otherFolder: '' }, DIRS), { kind: 'clipboard' });
    eq(destinationFor({ saveTo: 'pictures', otherFolder: '' }, DIRS), { kind: 'stock' });
    eq(destinationFor({ saveTo: 'other', otherFolder: '/mnt/x' }, DIRS), { kind: 'folder', path: '/mnt/x' });
});

test('destinationFor: a missing folder keeps GNOME\'s', () => {
    eq(destinationFor({ saveTo: 'other', otherFolder: '' }, DIRS), { kind: 'stock' });
    eq(destinationFor({ saveTo: 'desktop', otherFolder: '' }, { desktop: '', documents: '' }), { kind: 'stock' });
});

const STOCK = { path: '/h/Pictures/Screenshots/Screenshot From 2026-03-09 08-05-07.png', name: 'Screenshot From 2026-03-09 08-05-07.png' };

test('commitPlan: macOS names into the chosen folder', () => {
    eq(commitPlan({ kind: 'folder', path: '/h/Desktop' }, STOCK, { macosNames: true, stamp: STAMP }), {
        kind: 'file', dir: '/h/Desktop', stem: 'Screenshot 2026-03-09 at 08.05.07', ext: 'png', same: false,
    });
});

test('commitPlan: GNOME folder is only renamed; GNOME names are kept when asked', () => {
    eq(commitPlan({ kind: 'stock' }, STOCK, { macosNames: true, stamp: STAMP }), {
        kind: 'file', dir: '/h/Pictures/Screenshots', stem: 'Screenshot 2026-03-09 at 08.05.07', ext: 'png', same: true,
    });
    eq(commitPlan({ kind: 'stock' }, STOCK, { macosNames: false, stamp: STAMP }).stem, 'Screenshot From 2026-03-09 08-05-07');
});

test('commitPlan: clipboard drops the file', () => {
    eq(commitPlan({ kind: 'clipboard' }, STOCK, { macosNames: true, stamp: STAMP }), { kind: 'trash' });
});

test('modeSpec and modeFrom are inverse over MODES', () => {
    for (const m of MODES) {
        const s = modeSpec(m);
        eq(modeFrom(s.target, s.cast), m);
    }
    eq(modeSpec('record-selection'), { target: 'selection', cast: true });
    eq(modeFrom('window', true), 'record-selection'); // windows cannot be recorded
});

test('spaceToggle swaps selection and window', () => {
    eq(spaceToggle('selection'), 'window');
    eq(spaceToggle('window'), 'selection');
    eq(spaceToggle('screen'), 'window');
});

test('isCapturableArea', () => {
    eq(isCapturableArea({ width: 100, height: 80 }), true);
    eq(isCapturableArea({ width: 2, height: 80 }), false);
    eq(isCapturableArea(null), false);
});

test('countdown: ticks from the timer down to 1', () => {
    eq(countdown(0), []);
    eq(countdown(5), [5, 4, 3, 2, 1]);
    eq(countdown(10).length, 10);
    eq(countdown(3), []);
});

const MON = { x: 0, y: 0, width: 1280, height: 800 };

test('defaultSelection: middle quarter, like the stock UI', () => {
    eq(defaultSelection(MON), { x: 480, y: 300, width: 320, height: 200 });
});

test('selectionFromList / selectionToList round trip; junk is null', () => {
    eq(selectionFromList([10, 20, 300, 200]), { x: 10, y: 20, width: 300, height: 200 });
    eq(selectionToList({ x: 10, y: 20, width: 300, height: 200 }), [10, 20, 300, 200]);
    eq([selectionFromList([]), selectionFromList([1, 2, 3]), selectionFromList([0, 0, 1, 1]),
        selectionFromList(null), selectionFromList([0, 0, NaN, 9])], [null, null, null, null, null]);
});

test('startSelection: remembers only when on and still on the stage', () => {
    const stage = { width: 1280, height: 800 };
    const last = { x: 100, y: 100, width: 400, height: 300 };
    eq(startSelection({ remember: true, last, stage, primary: MON }), last);
    eq(startSelection({ remember: false, last, stage, primary: MON }), defaultSelection(MON));
    eq(startSelection({ remember: true, last: null, stage, primary: MON }), defaultSelection(MON));
    eq(startSelection({ remember: true, last: { x: 1000, y: 100, width: 400, height: 300 }, stage, primary: MON }),
        defaultSelection(MON));
});

test('thumbnailSize fits the box and never enlarges', () => {
    eq(thumbnailSize(1280, 800), { width: 220, height: 138 });
    eq(thumbnailSize(100, 50), { width: 100, height: 50 });
    eq(thumbnailSize(300, 900), { width: 50, height: 150 });
    eq(thumbnailSize(0, 0), { width: THUMBNAIL_BOX.width, height: THUMBNAIL_BOX.height });
});

test('thumbnailRest: bottom-right of the work area; entry offset slides in from the edge', () => {
    const area = { x: 0, y: 32, width: 1280, height: 700 };
    const rest = thumbnailRest(area, { width: 220, height: 138 });
    eq(rest, { x: 1040, y: 574 });
    eq(thumbnailEntryOffset(area, rest), 240);
});

test('swipeOutcome: past a third of the width dismisses', () => {
    eq(swipeOutcome(100, 220), 'dismiss');
    eq(swipeOutcome(40, 220), 'cancel');
    eq(swipeOutcome(-300, 220), 'cancel');
    eq(swipeOffset(50), 50);
    eq(swipeOffset(-60), -10);
});

test('ThumbnailLife: counts down, hover pauses, leaving resumes', () => {
    const life = new ThumbnailLife(1000);
    eq(life.remaining(1000), THUMBNAIL_MS);
    eq(life.remaining(3000), 3000);
    life.pause(3000);
    eq(life.remaining(60000), 3000);
    life.pause(61000); // idempotent
    eq(life.remaining(61000), 3000);
    life.resume(70000);
    eq(life.remaining(71000), 2000);
    eq(life.remaining(99999), 0);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
