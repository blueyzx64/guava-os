// classify.js: pure jitter classifier. No Shell, GLib or Gio calls; runs in gjs, node and the Shell.
// Plain script (not a module) so bundle.sh can embed it and the Shell can eval it:
//   const classify = new Function(src + '; return guavaClassify;')();
// In node: require('./classify.js').guavaClassify.
//
// Input: samples = [{t, x, y, w, h, op, sx, sy, vis}, ...], one per painted frame, in order.
//   t ms, x/y/w/h stage pixels (transformed), op 0..255 (paint opacity), sx/sy scale, vis boolean.
// Use ONE animation per series (open, then close): a fade in followed by a fade out is two animations.
// Output: {samples, jumps, reversals, flickers, detail}.
//
//   Geometry (jumps, reversals) uses only samples with vis=true; flicker uses all samples.
//   jump      a frame whose step is more than jumpFactor (3) x the median step of that channel
//             (position, size, scale, opacity), counting only steps that actually move, and only
//             when the step is also over an absolute floor (2 px, 0.02 scale, 20 opacity).
//             It must also exceed 1.5x its larger neighbouring step (a spike, not an easing curve).
//             Needs at least 5 moving steps, else there is no "motion" to compare against.
//   reversal  a direction change on one channel (x, y, w, h, opacity, scale) after hysteresis
//             (0.5 px, 2 opacity, 0.005 scale). ONE overshoot that settles is allowed: the first
//             flip is free when the return leg is at most 35% of the first leg. Every other flip counts.
//   flicker   visibility (or a opacity step of 64+) that flips and flips back within 2 frames.
function guavaClassify(samples, opts) {
    const o = Object.assign({
        jumpFactor: 3, spikeFactor: 1.5, maxOvershoot: 0.35, flickerFrames: 2, flickerOpStep: 64, flickerOpBack: 16,
    }, opts || {});
    const n = samples.length;
    const detail = {jumpFrames: [], reversals: {}, flickerFrames: []};
    const out = {samples: n, jumps: 0, reversals: 0, flickers: 0, detail};
    if (n < 2)
        return out;

    const med = a => {
        const s = [...a].sort((p, q) => p - q);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    // ---- jumps
    const channels = [
        {name: 'pos', eps: 0.25, floor: 2, d: (a, b) => Math.hypot(b.x - a.x, b.y - a.y)},
        {name: 'size', eps: 0.25, floor: 2, d: (a, b) => Math.hypot(b.w - a.w, b.h - a.h)},
        {name: 'scale', eps: 0.001, floor: 0.02, d: (a, b) => Math.hypot(b.sx - a.sx, b.sy - a.sy)},
        {name: 'opacity', eps: 1, floor: 20, d: (a, b) => Math.abs(b.op - a.op)},
    ];
    // Geometry is only meaningful while the actor is there: drop samples where it is missing or hidden.
    const gi = [];
    samples.forEach((s, i) => { if (s.vis) gi.push(i); });
    const g = gi.map(i => samples[i]);
    const gn = g.length;
    const jf = new Set();
    for (const c of channels) {
        const steps = [];
        for (let i = 1; i < gn; i++)
            steps.push(c.d(g[i - 1], g[i]));
        const moving = steps.filter(s => s > c.eps);
        if (moving.length < 5)
            continue;
        const lim = Math.max(o.jumpFactor * med(moving), c.floor);
        steps.forEach((s, i) => {
            // Also a spike against its neighbours: a strong ease-out starts with a big step that is
            // legitimate, a skipped frame is much bigger than the steps on both sides of it.
            const nb = Math.max(i > 0 ? steps[i - 1] : 0, i < steps.length - 1 ? steps[i + 1] : 0);
            if (s > lim && s > o.spikeFactor * nb)
                jf.add(gi[i + 1]);
        });
    }
    detail.jumpFrames = [...jf].sort((a, b) => a - b);
    out.jumps = jf.size;

    // ---- reversals (zigzag turning points with hysteresis)
    const series = [
        ['x', 0.5, s => s.x], ['y', 0.5, s => s.y], ['w', 0.5, s => s.w], ['h', 0.5, s => s.h],
        ['op', 2, s => s.op], ['sx', 0.005, s => s.sx], ['sy', 0.005, s => s.sy],
    ];
    for (const [name, db, get] of series) {
        if (gn < 2)
            break;
        const v = g.map(get);
        const pts = [v[0]];            // start, then confirmed extremes, then the last value
        let dir = 0, ext = v[0];
        for (let i = 1; i < gn; i++) {
            const x = v[i];
            if (dir === 0) {
                if (Math.abs(x - ext) >= db) { dir = Math.sign(x - ext); ext = x; }
            } else if (dir * (x - ext) > 0) {
                ext = x;
            } else if (Math.abs(x - ext) >= db) {
                pts.push(ext); dir = -dir; ext = x;
            }
        }
        pts.push(ext);
        const amp = [];
        for (let i = 1; i < pts.length; i++)
            amp.push(Math.abs(pts[i] - pts[i - 1]));
        let flips = amp.length - 1;
        if (flips >= 1 && amp[0] > 0 && amp[1] <= o.maxOvershoot * amp[0])
            flips -= 1;
        if (flips > 0) {
            detail.reversals[name] = flips;
            out.reversals += flips;
        }
    }

    // ---- flickers
    const ff = new Set();
    for (let i = 1; i < n; i++) {
        for (let k = 1; k <= o.flickerFrames && i + k < n; k++) {
            if (!!samples[i].vis !== !!samples[i - 1].vis && !!samples[i + k].vis === !!samples[i - 1].vis) {
                ff.add(i); break;
            }
        }
        for (let k = 1; k <= o.flickerFrames && i + k < n; k++) {
            if (Math.abs(samples[i].op - samples[i - 1].op) >= o.flickerOpStep &&
                Math.abs(samples[i + k].op - samples[i - 1].op) <= o.flickerOpBack) {
                ff.add(i); break;
            }
        }
    }
    detail.flickerFrames = [...ff].sort((a, b) => a - b);
    out.flickers = ff.size;
    return out;
}
if (typeof module !== 'undefined')
    module.exports = {guavaClassify};
