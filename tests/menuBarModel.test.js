// Run: gjs -m tests/menuBarModel.test.js
import {
    chooseText, touchesBar, barLook, leadingAlignment, parseOsRelease, systemLogoNames, parseCpuInfo, parseMemTotal,
    formatBytes, deviceModel, chassisIcon, gpuNames, parseRecentXbel, forceQuitRows,
    privacyDots, micApps, confirmationHolds, fillPlaceholders, fitMenus,
} from '../features/menuBar/model.js';
import { relativeLuminance, wallpaperBand, bandLuminance, decodesByRatio } from '../lib/wallpaperModel.js';

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
const near = (a, b, d = 0.01) => {
    if (Math.abs(a - b) > d)
        throw new Error(`expected ~${b}, got ${a}`);
};

test('luminance of black, white and grey', () => {
    eq(relativeLuminance(0, 0, 0), 0);
    near(relativeLuminance(255, 255, 255), 1);
    near(relativeLuminance(128, 128, 128), 0.216);
});

const mon = { width: 1280, height: 800 };
test('zoom crops the image to the monitor and takes the top band', () => {
    // 16:9 image on a 16:10 monitor: cropped left and right
    eq(wallpaperBand({ width: 1920, height: 1080 }, mon, 'zoom', 32), { x: 95, y: 0, width: 1729, height: 44 });
    // taller image: cropped top and bottom
    const r = wallpaperBand({ width: 1000, height: 2000 }, mon, 'zoom', 32);
    eq([r.x, r.width], [0, 1000]);
    near(r.y, 687, 1);
});
test('stretched, wallpaper and none', () => {
    eq(wallpaperBand({ width: 640, height: 400 }, mon, 'stretched', 32), { x: 0, y: 0, width: 640, height: 16 });
    eq(wallpaperBand({ width: 64, height: 64 }, mon, 'wallpaper', 32), { x: 0, y: 0, width: 64, height: 32 });
    eq(wallpaperBand({ width: 64, height: 64 }, mon, 'none', 32), null);
});
test('scaled and centered: the band can be the background colour', () => {
    eq(wallpaperBand({ width: 1280, height: 200 }, mon, 'scaled', 32), null);
    eq(wallpaperBand({ width: 1280, height: 800 }, mon, 'scaled', 32), { x: 0, y: 0, width: 1280, height: 32 });
    eq(wallpaperBand({ width: 100, height: 100 }, mon, 'centered', 32), null);
    eq(wallpaperBand({ width: 2560, height: 1600 }, mon, 'centered', 32), { x: 640, y: 400, width: 1280, height: 32 });
});

function solid(w, h, rgb) {
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++)
        px.set(rgb, i * 3);
    return px;
}
test('band luminance of a solid and a half/half image', () => {
    const white = bandLuminance(solid(10, 4, [255, 255, 255]), { rowstride: 30, channels: 3 }, { x: 0, y: 0, width: 10, height: 4 });
    near(white.mean, 1);
    near(white.spread, 0);
    const px = solid(10, 2, [0, 0, 0]);
    for (let y = 0; y < 2; y++)
        for (let x = 5; x < 10; x++)
            px.set([255, 255, 255], (y * 10 + x) * 3);
    const mixed = bandLuminance(px, { rowstride: 30, channels: 3 }, { x: 0, y: 0, width: 10, height: 2 });
    near(mixed.mean, 0.5);
    near(mixed.spread, 1);
});

test('text flips with hysteresis', () => {
    eq(chooseText({ mean: 0.9, spread: 0 }), { darkText: true, scrim: false, solid: false });
    eq(chooseText({ mean: 0.02, spread: 0 }), { darkText: false, scrim: false, solid: false });
    eq(chooseText({ mean: 0.16, spread: 0 }, true).darkText, true);   // stays dark
    eq(chooseText({ mean: 0.10, spread: 0 }, true).darkText, false);  // flips
    eq(chooseText({ mean: 0.20, spread: 0 }, false).darkText, false); // stays light
    eq(chooseText({ mean: 0.5, spread: 0.6 }).scrim, true);           // a wide spread
});

test('contrast-safe: a half black, half white band keeps the solid bar', () => {
    // Left half black, right half white: the mean (0.5) used to pick dark text over the black half
    const split = { mean: 0.5, spread: 1, low: 0, high: 1 };
    eq(chooseText(split).solid, true);
    // Mostly dark with a bright patch: light text, but a scrim, not solid
    const patch = { mean: 0.08, spread: 0.2, low: 0.02, high: 0.3 };
    const t = chooseText(patch);
    eq([t.darkText, t.scrim, t.solid], [false, true, false]);
    // The darkest tenth decides for dark text: a bright band with dark corners is not "light"
    eq(chooseText({ mean: 0.7, spread: 0.5, low: 0.05, high: 0.95 }).solid, true);
    // A uniformly readable band needs neither
    eq(chooseText({ mean: 0.04, spread: 0.02, low: 0.03, high: 0.05 }), { darkText: false, scrim: false, solid: false });
});

test('band luminance reports the 10th and 90th percentile', () => {
    const px = solid(10, 2, [0, 0, 0]);
    for (let y = 0; y < 2; y++)
        for (let x = 5; x < 10; x++)
            px.set([255, 255, 255], (y * 10 + x) * 3);
    const m = bandLuminance(px, { rowstride: 30, channels: 3 }, { x: 0, y: 0, width: 10, height: 2 });
    near(m.low, 0);
    near(m.high, 1);
});

test('wallpapers placed by their real pixels are not decoded by ratio', () => {
    eq(['zoom', 'stretched', 'scaled', 'spanned'].every(decodesByRatio), true);
    eq(['centered', 'wallpaper'].some(decodesByRatio), false);
});

test('force quit: the confirmation holds only for the app it named', () => {
    eq(confirmationHolds('a', 'a'), true);
    eq(confirmationHolds('a', 'b'), false);
    eq(confirmationHolds(null, null), false);
    eq(confirmationHolds(null, 'a'), false);
});

test('placeholders are filled in order and are not read as patterns', () => {
    eq(fillPlaceholders('Log Out %s…', 'Ann'), 'Log Out Ann…');
    eq(fillPlaceholders('Log Out %s…', "$&'$$"), "Log Out $&'$$…");
    eq(fillPlaceholders('%s, %s available', '1 TB', '$& GB'), '1 TB, $& GB available');
    eq(fillPlaceholders('%s and %s', 'x'), 'x and %s');
});

test('menu strip: everything fits', () => {
    eq(fitMenus([60, 40, 40], 200, 20), { shown: 3, more: false, xs: [0, 60, 100], moreX: 140 });
});

test('menu strip: the menus that do not fit go behind the » button', () => {
    // 60 + 40 + 40 + 40 = 180 > 150: the app name, File and room for »
    eq(fitMenus([60, 40, 40, 40], 150, 20), { shown: 2, more: true, xs: [0, 60], moreX: 100 });
    // the app name is always shown, even when it alone is wider than the strip
    eq(fitMenus([300, 40], 100, 20), { shown: 1, more: true, xs: [0], moreX: 300 });
    // the » button needs its room: 60 + 50 would fit, 60 + 50 + 20 would not
    eq(fitMenus([60, 50, 40], 125, 20).shown, 1);
    eq(fitMenus([], 100, 20), { shown: 0, more: false, xs: [], moreX: 0 });
});

test('menu strip: right-to-left text starts at the right edge', () => {
    eq(fitMenus([60, 40, 40], 200, 20, true), { shown: 3, more: false, xs: [140, 100, 60], moreX: 40 });
    eq(fitMenus([60, 40, 40, 40], 150, 20, true), { shown: 2, more: true, xs: [90, 50], moreX: 30 });
});

test('a window touches the bar at the top of the work area', () => {
    const area = { x: 0, y: 32, width: 1280, height: 768 };
    eq(touchesBar({ x: 100, y: 32, width: 300 }, area), true);
    eq(touchesBar({ x: 100, y: 33, width: 300 }, area), false);
    eq(touchesBar({ x: 1300, y: 0, width: 300 }, area), false);
});

test('bar look', () => {
    eq(barLook({ transparent: true, windowAtTop: false, solidOnWindow: true, solidOnly: false }), 'clear');
    eq(barLook({ transparent: true, windowAtTop: true, solidOnWindow: true, solidOnly: false }), 'solid');
eq(barLook({ transparent: true, windowAtTop: true, solidOnWindow: false, solidOnly: false }), 'clear');
    eq(barLook({ transparent: false, windowAtTop: false, solidOnly: false }), 'solid');
    eq(barLook({ transparent: true, windowAtTop: false, solidOnly: true }), 'solid');
});

test('os-release, cpuinfo and meminfo', () => {
    const os = parseOsRelease('NAME="Fedora Linux"\nVERSION="44 (Workstation Edition)"\nLOGO=fedora-logo-icon\n# c\nX=\'a\\"b\'');
    eq([os.NAME, os.VERSION, os.LOGO, os.X], ['Fedora Linux', '44 (Workstation Edition)', 'fedora-logo-icon', 'a"b']);
    const cpu = parseCpuInfo('processor\t: 0\nmodel name\t: Intel(R) Core(TM) i7-1185G7  @ 3.00GHz\n\nprocessor\t: 1\nmodel name\t: Intel(R) Core(TM) i7-1185G7 @ 3.00GHz\n');
    eq(cpu, { model: 'Intel Core i7-1185G7 @ 3.00GHz', threads: 2 });
    eq(parseCpuInfo(''), { model: null, threads: 0 });
    eq(parseMemTotal('MemTotal:       16314192 kB\nMemFree: 1 kB'), 16314192 * 1024);
});

test('sizes and models', () => {
    eq(formatBytes(512110190592), '512 GB');
    eq(formatBytes(1500000000000), '1.5 TB');
    eq(formatBytes(16314192 * 1024, { memory: true }), '16 GB');
    // MemTotal is below the installed size (iGPU-reserved memory): round up to the module size
    eq(formatBytes(15.2 * 1024 ** 3, { memory: true }), '16 GB');
    eq(formatBytes(7.6 * 1024 ** 3, { memory: true }), '8 GB');
    eq(formatBytes(30.9 * 1024 ** 3, { memory: true }), '32 GB');
    eq(formatBytes(64 * 1024 ** 3, { memory: true }), '64 GB');
    eq(formatBytes(0), '');
    eq(deviceModel('LENOVO', '21CB'), 'LENOVO 21CB');
    eq(deviceModel('Framework', 'Framework Laptop 13'), 'Framework Laptop 13');
    eq(deviceModel('QEMU', 'Standard PC'), 'QEMU Standard PC');
    eq(deviceModel('System manufacturer', 'System Product Name'), 'System manufacturer');
    eq(deviceModel(null, null), null);
    eq(chassisIcon('laptop'), 'computer-laptop-symbolic');
    eq(chassisIcon('vm'), 'computer-symbolic');
    eq(gpuNames([{ Name: 'Intel' }, { Name: 'NVIDIA', Default: true }, {}]), ['NVIDIA', 'Intel']);
});

test('recent documents, newest first, unique', () => {
    const xml = `<xbel><bookmark href="file:///home/u/a%20b.txt" added="x" modified="2026-01-01T10:00:00Z" visited="2026-01-02T10:00:00Z"><info><metadata><mime:mime-type type="text/plain"/></metadata></info></bookmark>
<bookmark href="file:///home/u/c.png" modified="2026-03-01T10:00:00Z"></bookmark>
<bookmark href="file:///home/u/dir/" modified="2025-03-01T10:00:00Z"></bookmark>
<bookmark href="file:///home/u/c.png" modified="2020-03-01T10:00:00Z"></bookmark></xbel>`;
    const r = parseRecentXbel(xml);
    eq(r.map(x => x.name), ['c.png', 'a b.txt', 'dir']);
    eq(r[1].mime, 'text/plain');
    eq(parseRecentXbel(xml, 1).length, 1);
    eq(parseRecentXbel(''), []);
});

test('force quit rows: windowed apps by name, unresponsive flagged', () => {
    eq(forceQuitRows([
        { id: 'b', name: 'Text Editor', windows: [{ alive: true }] },
        { id: 'a', name: 'Calculator', windows: [{ alive: true }, { alive: false }] },
        { id: 'c', name: 'Daemon', windows: [] },
    ]), [{ id: 'a', name: 'Calculator', notResponding: true }, { id: 'b', name: 'Text Editor', notResponding: false }]);
});

test('privacy dots and mic apps', () => {
    eq(privacyDots({ mic: true, camera: true, screen: true }), ['screen', 'camera', 'mic']);
    eq(privacyDots({ mic: false, camera: false, screen: false }), []);
    eq(micApps([{ appId: 'org.gnome.VolumeControl', name: 'Settings' }, { appId: 'x', name: 'Recorder' },
        { appId: 'y', name: 'Recorder' }, { appId: 'z', name: null }]), ['Recorder', 'z']);
});

test('systemLogoNames tries the symbolic icon first', () => {
    eq(systemLogoNames('fedora-logo-icon'), ['fedora-logo-icon-symbolic', 'fedora-logo-icon']);
    eq(systemLogoNames('x-symbolic'), ['x-symbolic']);
});

test('menu placement aligns leading edges', () => {
    eq(leadingAlignment({ rtl: false, width: 0, contentStart: 3, contentWidth: 0 }), 0);
    eq(leadingAlignment({ rtl: true, width: 0, contentStart: 3, contentWidth: 0 }), 1);
    eq(leadingAlignment({ rtl: false, width: 100, contentStart: 0, contentWidth: 100 }), 0);
    eq(leadingAlignment({ rtl: false, width: 100, contentStart: 10, contentWidth: 80 }), -0.125);
    eq(leadingAlignment({ rtl: true, width: 100, contentStart: 10, contentWidth: 80 }), 1.125);
});

if (failed)
    throw new Error(`${failed} failed`);
