// Unit tests for classify.js. Run: node test-classify.js   or   gjs -m test-classify.mjs (see README)
// Works in node and gjs: loads classify.js as text and evals it.
let src, say, exit;
if (typeof process !== 'undefined' && process.versions?.node) {
    src = require('fs').readFileSync(require('path').join(__dirname, 'classify.js'), 'utf8');
    say = console.log; exit = process.exit;
} else {
    const {GLib} = imports.gi;
    const dir = GLib.path_get_dirname(imports.system.programInvocationName.startsWith('/') ? imports.system.programInvocationName : GLib.build_filenamev([GLib.get_current_dir(), imports.system.programInvocationName]));
    src = new TextDecoder().decode(GLib.file_get_contents(dir + '/classify.js')[1]);
    say = print; exit = imports.system.exit;
}
const guavaClassify = new Function(src + '; return guavaClassify;')();

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    if (got === want) pass++; else { fail++; say(`FAIL ${name}: got ${got}, want ${want}`); }
};
// build samples from a function of frame index
const mk = (n, f) => Array.from({length: n}, (_, i) => Object.assign({t: i * 16.7, x: 0, y: 0, w: 100, h: 100, op: 255, sx: 1, sy: 1, vis: true}, f(i)));
const ease = u => 1 - Math.pow(1 - u, 3);

// smooth ease-out slide: clean
let r = guavaClassify(mk(20, i => ({x: 400 * ease(i / 19)})));
eq('smooth slide jumps', r.jumps, 0); eq('smooth slide reversals', r.reversals, 0); eq('smooth slide flickers', r.flickers, 0);

// linear slide with one big skipped frame
r = guavaClassify(mk(20, i => ({x: i < 10 ? i * 10 : i * 10 + 80})));
eq('skip jumps', r.jumps, 1); eq('skip jump frame', r.detail.jumpFrames[0], 10);

// spring: one overshoot that settles is not a reversal
r = guavaClassify(mk(24, i => ({y: i < 12 ? 200 * (i / 11) * 1.1 : 220 - 20 * ((i - 11) / 12)})));
eq('overshoot reversals', r.reversals, 0);

// back and forth wobble: reversals
r = guavaClassify(mk(24, i => ({x: [0, 50, 100, 60, 20, 70, 120][Math.min(6, Math.floor(i / 4))] })));
eq('wobble reversals >=2', r.reversals >= 2, true);

// big return (retreat 80% of the first leg) counts
r = guavaClassify(mk(20, i => ({x: i < 10 ? i * 10 : 90 - (i - 9) * 8})));
eq('retreat reversal', r.reversals, 1);

// visibility flicker: off for 1 frame
r = guavaClassify(mk(12, i => ({vis: i !== 5})));
eq('vis flicker', r.flickers, 1);
// visibility off for 5 frames is not a flicker
r = guavaClassify(mk(12, i => ({vis: i < 3 || i > 7})));
eq('vis gap not flicker', r.flickers, 0);
// opacity blink
r = guavaClassify(mk(12, i => ({op: i === 6 ? 0 : 255})));
eq('opacity flicker', r.flickers, 1);
// plain fade in: nothing
r = guavaClassify(mk(16, i => ({op: Math.round(255 * ease(i / 15))})));
eq('fade clean', r.jumps + r.reversals + r.flickers, 0);
// too few samples / still actor
eq('empty', guavaClassify([]).jumps, 0);
r = guavaClassify(mk(10, () => ({})));
eq('still actor', r.jumps + r.reversals + r.flickers, 0);

// actor absent for the first frames (vis=false, zeros) then appears: not a jump
r = guavaClassify(mk(20, i => i < 4 ? {vis: false, x: 0, y: 0, w: 0, h: 0} : {x: 300 + (i - 4) * 5}));
eq('late appear no jump', r.jumps, 0);

say(`classify tests: pass=${pass} fail=${fail}`);
exit(fail ? 1 : 0);
