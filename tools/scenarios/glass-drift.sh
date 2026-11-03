# Scenario (GUAVA_EXTRA): glass does not drift, ghost or go stale (F1, RV2-1/3/4/7/8/9/11).
# Bundle: K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/glass-drift.sh
#   - RV2-1: 50 partial redraws under a menu leave its pixels where they were (no self-blur)
#   - RV2-3: a window that overlapped the bar and the dock leaves; their blur shows the wallpaper again
#   - RV2-4: a colour-scheme flip and a BackgroundManager 'changed' recapture the static blurs
#   - RV2-7: gl-video-memory-purged drops the textures and the next paint rebuilds them
#   - RV2-8: a surface that resizes by pixels reuses its textures
#   - RV2-9/11: the governor reads its own clock; a paint failure does not outlive a re-configure
# Runs at any GUAVA_SCALE / GUAVA_MONITORS.
cat > $W/mkwall.js <<'JS'
const Cairo = imports.cairo;
const W = 3840, H = 2400, dark = ARGV[1] === 'dark';
const s = new Cairo.ImageSurface(Cairo.Format.RGB24, W, H);
const c = new Cairo.Context(s);
const g = new Cairo.LinearGradient(0, 0, W, H);
if (dark) { g.addColorStopRGB(0, 0.05, 0.10, 0.30); g.addColorStopRGB(1, 0.02, 0.30, 0.15); }
else { g.addColorStopRGB(0, 0.95, 0.45, 0.20); g.addColorStopRGB(0.5, 0.55, 0.20, 0.75); g.addColorStopRGB(1, 0.10, 0.45, 0.85); }
c.setSource(g); c.paint();
for (let i = 0; i < 160; i++) { c.setSourceRGBA(i % 2, 1, (i % 3) / 2, 0.9); c.rectangle(i * 24, 0, 12, 160); c.fill(); }
for (let i = 0; i < 160; i++) { c.setSourceRGBA(i % 2, (i % 5) / 4, 1, 0.9); c.rectangle(i * 24, H - 700, 12, 400); c.fill(); }
for (let i = 0; i < 90; i++) { c.setSourceRGBA((i * 37 % 255) / 255, (i * 91 % 255) / 255, (i * 53 % 255) / 255, 0.95); c.arc((i * 151) % W, 300 + (i * 97) % (H - 600), 30 + (i % 5) * 30, 0, 6.283); c.fill(); }
s.writeToPNG(ARGV[0]);
JS
cat > $W/cmp.js <<'JS'
// gjs cmp.js a.png b.png x y w h  ->  "mean=.. max=.."
imports.gi.versions.GdkPixbuf = '2.0';
const { GdkPixbuf } = imports.gi;
const [a, b] = [ARGV[0], ARGV[1]];
const [x, y, w, h] = ARGV.slice(2).map(Number);
const pa = GdkPixbuf.Pixbuf.new_from_file(a), pb = GdkPixbuf.Pixbuf.new_from_file(b);
const da = pa.get_pixels(), db = pb.get_pixels(), n = pa.get_n_channels(), rs = pa.get_rowstride();
let sum = 0, max = 0, cnt = 0;
for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) for (let k = 0; k < 3; k++) {
    const o = j * rs + i * n + k, d = Math.abs(da[o] - db[o]); sum += d; cnt++; if (d > max) max = d;
}
print(`mean=${(sum / cnt).toFixed(3)} max=${max}`);
JS
gjs $W/mkwall.js $W/wall.png light
gjs $W/mkwall.js $W/walld.png dark
gsettings set org.gnome.desktop.background picture-uri "file://$W/wall.png"
gsettings set org.gnome.desktop.background picture-uri-dark "file://$W/wall.png"
gsettings set org.gnome.desktop.background picture-options zoom
force_animations on
sleep 2
FX='const fx=a=>a?.get_effect?.("guava-glass")??null; const cc=()=>Main.panel.statusArea.quickSettings.menu;
const glassActors=()=>{const out=[];const walk=a=>{if(fx(a))out.push(a);for(const c of a.get_children())walk(c);};walk(global.stage);return out;};
const rect=a=>{const [x,y]=a.get_transformed_position();const [w,h]=a.get_transformed_size();const s=global.display.get_monitor_scale(Main.layoutManager.primaryIndex);return [Math.round(x*s),Math.round(y*s),Math.round(w*s),Math.round(h*s)];};
const MON=global.display.get_monitor_geometry(0), MW=MON.width, MH=MON.height;
const EXT=Main.extensionManager.lookup("guava-os@blueyzx64").dir.get_path();'
# cmp_shots A B X Y W H NAME MAXMEAN: pixel difference of a region between two screenshots
cmp_shots() {
  local r mean
  r=$(gjs $W/cmp.js /opt/shots/$1.png /opt/shots/$2.png $3 $4 $5 $6 2>/dev/null | grep "^mean=" | head -1)
  mean=${r#mean=}; mean=${mean%% *}
  if [ -n "$r" ] && awk -v m="$mean" -v t="$8" 'BEGIN{exit !(m+0 <= t+0)}'; then
    GUAVA_ASSERT_PASS=$((GUAVA_ASSERT_PASS+1)); echo "ASSERT PASS $7 $r"
  else
    GUAVA_ASSERT_FAIL=$((GUAVA_ASSERT_FAIL+1)); echo "ASSERT FAIL $7 $r"
  fi
}
rect_of() { _kjs "$FX return 'RECT ' + $1" | grep -o 'RECT [0-9 ]*' | head -1 | sed 's/RECT //'; }
_kjs 'Main.overview.show(); await sl(900); Main.overview.hide(); await sl(1800); return 1' >/dev/null
launch_app "gnome-text-editor" org.gnome.TextEditor 40

echo "-- RV2-1: no drift under partial redraws (menu)"
_kjs "$FX cc().open(); await sl(1500); return 1" >/dev/null
assert drift-menu-live "(()=>{ $FX const f=fx(cc().box); return f?.enabled && !!f._out; })()"
R=$(rect_of "rect(cc().box).join(' ')")
echo "menu rect: $R"
shot drift-menu-a
_kjs "$FX const b=cc().box; const leaves=[]; const walk=a=>{const k=a.get_children(); if(!k.length) leaves.push(a); for(const c of k) walk(c);}; walk(b);
const t=leaves.filter(l=>l.mapped).slice(0,6); for(let i=0;i<50;i++){ t[i%t.length].queue_redraw(); await sl(110);} return 1" >/dev/null
shot drift-menu-b
set -- $R
cmp_shots drift-menu-a drift-menu-b $1 $2 $3 $4 no-drift-menu-50-partial-redraws 0.5
_kjs "$FX const f=fx(cc().box); return 'STATS captures=' + f.stats.captures + ' allocations=' + f.stats.allocations + ' retries=' + f.stats.retries + ' END'" | grep -o 'STATS .* END' 
_kjs "$FX cc().close(); await sl(600); return 1" >/dev/null

# A test surface in the dock's mode ('auto': one static blur while only the wallpaper is behind it) in
# a spot the real dock and bar never use, so autohide and relayout cannot recapture it by accident
_kjs "$FX const {Glass} = await import('file://'+EXT+'/lib/glass.js');
const t = new St.Widget({name:'f1-test', x:Math.round(MW*0.7), y:Math.round(MH*0.56), width:Math.round(MW*0.28), height:Math.round(MH*0.15)}); Main.uiGroup.add_child(t);
globalThis.__T = t; globalThis.__TH = Glass.attach(t, {surface:'dock', role:'content'}); await sl(2000);
const w=kwin('org.gnome.TextEditor'); w.move_resize_frame(true, Math.round(MW*0.02), Math.round(MH*0.12), Math.round(MW*0.3), Math.round(MH*0.4)); await sl(2500); return 1" >/dev/null
TR=$(rect_of "rect(globalThis.__T).join(' ')")
echo "test surface rect: $TR"
assert test-surface-has-glass "(()=>{ $FX const f=fx(globalThis.__T); return f?.enabled && f._mode==='auto' && !!f._out; })()"

echo "-- RV2-3: a window that overlapped an 'auto' surface leaves; its blur shows the wallpaper again"
# does the window, at its smallest, clear the test surface? (a 640 px wide monitor at scale 2 has no room)
CLEAR=$(_kjs "$FX const wa = kwin('org.gnome.TextEditor').get_compositor_private(), t = globalThis.__T; const [x,y]=wa.get_transformed_position(), [w,h]=wa.get_transformed_size(), [ax,ay]=t.get_transformed_position(), [aw,ah]=t.get_transformed_size(); return 'CLEAR=' + ((x<ax+aw&&ax<x+w&&y<ay+ah&&ay<y+h) ? 0 : 1)" | grep -o 'CLEAR=[01]' | head -1)
if [ "$CLEAR" = "CLEAR=1" ]; then
shot ghost-before
_kjs "$FX const t = globalThis.__T; const wa = kwin('org.gnome.TextEditor').get_compositor_private();
const seen={t:0}; globalThis.__seen=seen;
seen.id=global.stage.connect('after-paint',()=>{ if(!wa.visible||!wa.mapped||wa.opacity===0) return; const [x,y]=wa.get_transformed_position(), [w,h]=wa.get_transformed_size(), [ax,ay]=t.get_transformed_position(), [aw,ah]=t.get_transformed_size(); if (x<ax+aw&&ax<x+w&&y<ay+ah&&ay<y+h) seen.t=GLib.get_monotonic_time()/1000; });
kwin('org.gnome.TextEditor').move_frame(true, Math.round(MW*0.5), Math.round(MH*0.44)); await sl(1800); return 1" >/dev/null
assert window-was-behind-the-surface "globalThis.__seen.t > 0"
shot ghost-over
# one jump away, after sitting there: nothing animates, so only the edge (a window was behind,
# now none is) can bring the blur back to the wallpaper
_kjs "$FX kwin('org.gnome.TextEditor').move_frame(true, Math.round(MW*0.02), Math.round(MH*0.12)); await sl(1500); return 1" >/dev/null
_kjs "$FX const f=fx(globalThis.__T); return 'EDGE since-last-seen=' + Math.round(f._lastCapture - globalThis.__seen.t) + 'ms valid=' + f._valid + ' wasBehind=' + f._wasBehind + ' captures=' + f.stats.captures + ' END'" | grep -o 'EDGE .* END'
assert surface-captures-after-the-window-left "(()=>{ $FX const f=fx(globalThis.__T); return f._lastCapture > globalThis.__seen.t && f._valid; })()"
shot ghost-after
set -- $TR
cmp_shots ghost-before ghost-after $1 $2 $3 $4 no-ghost-after-window-leaves 0.3
_kjs 'global.stage.disconnect(globalThis.__seen.id); return 1' >/dev/null
else
  echo "SKIP RV2-3: the window cannot clear the test surface on this display"
fi

echo "-- RV2-4: colour-scheme flip and background change recapture the static blur"
gsettings set org.gnome.desktop.background picture-uri-dark "file://$W/walld.png"
gsettings set org.gnome.desktop.interface color-scheme prefer-dark; sleep 3.5
shot scheme-dark-a
_kjs "$FX fx(globalThis.__T).invalidate(); await sl(2500); return 1" >/dev/null
shot scheme-dark-b
set -- $TR
cmp_shots scheme-dark-a scheme-dark-b $1 $2 $3 $4 blur-current-after-scheme-flip 0.5
_kjs "$FX globalThis.__c1 = fx(globalThis.__T)._settleUntil; Main.layoutManager._bgManagers[0].emit('changed'); await sl(100); return 1" >/dev/null
assert bgmanager-changed-invalidates "(()=>{ $FX return fx(globalThis.__T)._settleUntil > globalThis.__c1; })()"
gsettings set org.gnome.desktop.interface color-scheme default; sleep 2

echo "-- RV2-7: gl-video-memory-purged"
_kjs "$FX global.stage.emit('gl-video-memory-purged'); globalThis.__purged = !fx(globalThis.__T)._out; await sl(1500); const f=fx(globalThis.__T); return 'PURGE out=' + !!f._out + ' valid=' + f._valid + ' captures=' + f.stats.captures + ' retries=' + f.stats.retries + ' bg=' + !!f._bg + ' bgOk=' + f._bgOk + ' enabled=' + f.enabled + ' END'" | grep -o 'PURGE .* END'
assert purge-drops-textures "globalThis.__purged === true"
assert purge-rebuilds-blur "(()=>{ $FX const f=fx(globalThis.__T); return !!f._out && f._valid; })()"
_kjs 'globalThis.__TH.destroy(); globalThis.__T.destroy(); return 1' >/dev/null

echo "-- RV2-8: a surface resized by pixels reuses its textures"
_kjs "$FX const {Glass} = await import('file://'+EXT+'/lib/glass.js');
const a = new St.Widget({style:'background-color: transparent;', x:300, y:300, width:200, height:120}); Main.uiGroup.add_child(a);
const h = Glass.attach(a, {surface:'overlays', role:'content'}); await sl(800);
const f = fx(a); const a0 = f.stats.allocations;
for (let i = 0; i < 40; i++) { a.set_size(200 + i, 120 + (i >> 1)); await sl(60); }
globalThis.__alloc = f.stats.allocations - a0; globalThis.__caps = f.stats.captures; h.destroy(); a.destroy(); return 1" | cut -c1-300
assert resize-reuses-textures "globalThis.__alloc <= 4"
_kjs 'return "RESIZE allocations=" + globalThis.__alloc + " captures=" + globalThis.__caps' | grep -o 'RESIZE [^"]*'

echo "-- RV2-9/11: governor clock, failure recovery"
_kjs "$FX const gb = await import('file://'+EXT+'/lib/glassBlur.js');
const g = gb.governor; const now = GLib.get_monotonic_time()/1000; for (let i = 0; i < 40; i++) g.frame(now + i*16, 16.7);
for (let i = 0; i < 30; i++) g.frame(now + 640 + i*70, 16.7);
const frozen = g.frozen; g.idle(); globalThis.__gov = [frozen, g.frozen]; return 1" >/dev/null
assert governor-stays-frozen-at-idle-check "globalThis.__gov[0] === true && globalThis.__gov[1] === true"
_kjs "$FX const {Glass} = await import('file://'+EXT+'/lib/glass.js');
Glass.disableEffects(); const off = Glass.effects; Glass.configure(Glass._gs); globalThis.__eff = [off, Glass.effects]; Glass._refresh(); await sl(800); return 1" >/dev/null
assert failure-does-not-outlive-configure "globalThis.__eff[0] === false && globalThis.__eff[1] === true"
assert bar-glass-back "Main.panel.get_effect('guava-glass')?.enabled === true"
assert_summary
