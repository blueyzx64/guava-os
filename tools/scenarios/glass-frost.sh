# Scenario (GUAVA_EXTRA): the default look is a plain frosted Gaussian blur; liquid-glass on gives Liquid Glass (B41).
# Bundle: K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/glass-frost.sh
#   - defaults: liquid-glass is false; the menu bar, Control Center and the calendar carry the blur effect
#     with a flat fill (top = bottom), saturation 1, no rim, the guava-glass-frost class
#   - pixels: a glass test surface over the striped wallpaper is much smoother than the wallpaper just under
#     it (blurred), and differs from the same surface under Reduce Transparency (a real backdrop, not a
#     theme colour). The menu bar itself is clear over the wallpaper by design (features/menuBar), so a
#     test surface in the dock's mode stands in for it
#   - liquid-glass true: the Liquid Glass look unchanged (gradient fill, saturation boost, rim, no frost class)
#   - Reduce Transparency still makes the frosted surfaces opaque
#   - screenshots: frost-* (default) and liquid-* (Liquid Glass) of the bar, the dock and a menu over a window
cat > $W/mkwall.js <<'JS'
const Cairo = imports.cairo;
const W = 1280, H = 800;
const s = new Cairo.ImageSurface(Cairo.Format.RGB24, W, H);
const c = new Cairo.Context(s);
const g = new Cairo.LinearGradient(0, 0, W, H);
g.addColorStopRGB(0, 0.95, 0.45, 0.20); g.addColorStopRGB(0.5, 0.55, 0.20, 0.75); g.addColorStopRGB(1, 0.10, 0.45, 0.85);
c.setSource(g); c.paint();
for (let i = 0; i < 64; i++) { c.setSourceRGBA(i % 2, 1, (i % 3) / 2, 1); c.rectangle(i * 20, 0, 10, 64); c.fill(); }
for (let i = 0; i < 40; i++) { c.setSourceRGBA((i * 37 % 255) / 255, (i * 91 % 255) / 255, (i * 53 % 255) / 255, 0.95); c.arc((i * 151) % W, 120 + (i * 97) % (H - 200), 18 + (i % 5) * 14, 0, 6.283); c.fill(); }
c.setSourceRGB(1, 1, 1); c.rectangle(0, 700, W, 100); c.fill();
c.setSourceRGB(0, 0, 0); c.selectFontFace('Sans', 0, 1); c.setFontSize(40);
for (let i = 0; i < 5; i++) { c.moveTo(20 + i * 250, 760); c.showText('GUAVA ' + i); }
s.writeToPNG(ARGV[0]);
JS
# gjs stats.js shot.png x y w h -> "grad=<mean |horizontal neighbour difference|>"
cat > $W/stats.js <<'JS'
imports.gi.versions.GdkPixbuf = '2.0';
const { GdkPixbuf } = imports.gi;
const pa = GdkPixbuf.Pixbuf.new_from_file(ARGV[0]);
const [x, y, w, h] = ARGV.slice(1).map(Number);
const d = pa.get_pixels(), n = pa.get_n_channels(), rs = pa.get_rowstride();
let sum = 0, cnt = 0;
for (let j = y; j < y + h; j++) for (let i = x; i < x + w - 1; i++) for (let k = 0; k < 3; k++) {
    sum += Math.abs(d[j * rs + i * n + k] - d[j * rs + (i + 1) * n + k]); cnt++;
}
print(`grad=${(sum / cnt).toFixed(3)}`);
JS
cat > $W/diff.js <<'JS'
imports.gi.versions.GdkPixbuf = '2.0';
const { GdkPixbuf } = imports.gi;
const pa = GdkPixbuf.Pixbuf.new_from_file(ARGV[0]), pb = GdkPixbuf.Pixbuf.new_from_file(ARGV[1]);
const [x, y, w, h] = ARGV.slice(2).map(Number);
const da = pa.get_pixels(), db = pb.get_pixels(), n = pa.get_n_channels(), rs = pa.get_rowstride();
let sum = 0, cnt = 0;
for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) for (let k = 0; k < 3; k++) {
    sum += Math.abs(da[j * rs + i * n + k] - db[j * rs + i * n + k]); cnt++;
}
print(`diff=${(sum / cnt).toFixed(3)}`);
JS
grad() { gjs $W/stats.js /opt/shots/$1.png $2 $3 $4 $5 2>/dev/null | grep -o 'grad=[0-9.]*' | head -1 | sed 's/grad=//'; }
diffpx() { gjs $W/diff.js /opt/shots/$1.png /opt/shots/$2.png $3 $4 $5 $6 2>/dev/null | grep -o 'diff=[0-9.]*' | head -1 | sed 's/diff=//'; }
# num_assert NAME VALUE OP LIMIT: awk comparison, counted like assert
num_assert() {
  if [ -n "$2" ] && awk -v a="$2" -v b="$4" "BEGIN{exit !(a+0 $3 b+0)}"; then
    GUAVA_ASSERT_PASS=$((GUAVA_ASSERT_PASS+1)); echo "ASSERT PASS $1 ($2 $3 $4)"
  else
    GUAVA_ASSERT_FAIL=$((GUAVA_ASSERT_FAIL+1)); echo "ASSERT FAIL $1 ($2 $3 $4)"
  fi
}
gjs $W/mkwall.js $W/wall.png
gsettings set org.gnome.desktop.background picture-uri "file://$W/wall.png"
gsettings set org.gnome.desktop.background picture-uri-dark "file://$W/wall.png"
gsettings set org.gnome.desktop.background picture-options zoom
force_animations on
# the defaults: no explicit values for the keys under test
for k in liquid-glass liquid-glass-surfaces glass-reduce-transparency glass-increase-contrast; do gsettings reset org.gnome.shell.extensions.guava-os $k; done
sleep 2
FX='const fx=a=>a?.get_effect?.("guava-glass")??null; const cc=()=>Main.panel.statusArea.quickSettings.menu; const dm=()=>Main.panel.statusArea.dateMenu.menu;'
_kjs 'Main.overview.show(); await sl(900); Main.overview.hide(); await sl(1800); return 1' >/dev/null
launch_app "gnome-text-editor" org.gnome.TextEditor 40
_kjs 'const w=kwin("org.gnome.TextEditor"); w.move_resize_frame(true, 120, 120, 800, 480); w.activate(global.get_current_time()); await sl(1200); return 1' >/dev/null

echo "-- defaults: the frosted look"
assert default-liquid-glass-off "new Gio.Settings({schema_id:'org.gnome.shell.extensions.guava-os'}).get_boolean('liquid-glass') === false"
assert frost-bar-has-blur-effect "(()=>{ $FX const f=fx(Main.panel); return f?.enabled === true && !!f._look?.blur && f._look.blur.sigma > 0; })()"
assert frost-fill-is-flat "(()=>{ $FX const l=fx(Main.panel)._look; return l.top.join() === l.bottom.join(); })()"
assert frost-no-saturation-boost "(()=>{ $FX const b=fx(Main.panel)._look.blur; return b.saturation === 1 && b.brightness === 1 && b.lift === 0; })()"
assert frost-class-no-noise "Main.panel.has_style_class_name('guava-glass-frost') && !Main.panel.has_style_class_name('guava-glass-noise')"
shot frost-default-bar
_kjs "$FX cc().open(); await sl(1200); return 1" >/dev/null
assert frost-cc-blurred-no-rim "(()=>{ $FX const f=fx(cc().box); const b=cc().box; return f?.enabled && !!f._out && b.has_style_class_name('guava-glass-frost') && /box-shadow: none/.test(b.style) && /gradient-direction: none/.test(b.style) && !/gradient-end/.test(b.style); })()"
shot frost-default-cc
_kjs "$FX cc().close(); await sl(500); dm().open(); await sl(1200); return 1" >/dev/null
assert frost-calendar-blurred "(()=>{ $FX const f=fx(dm().box); return f?.enabled && !!f._out && dm().box.has_style_class_name('guava-glass-frost'); })()"
shot frost-default-menu-over-window
_kjs "$FX dm().close(); await sl(500); return 1" >/dev/null
assert frost-dock-blurred "(()=>{ $FX const find=a=>{ if (fx(a) && a.has_style_class_name?.('guava-glass-dock')) return a; for (const c of a.get_children()) { const r=find(c); if (r) return r; } return null; }; const d=find(global.stage); return !!d && d.has_style_class_name('guava-glass-frost') && fx(d)._look.blur.saturation === 1; })()"
shot frost-default-dock

echo "-- pixels: a real, blurred backdrop"
# A test surface over the 64 px tall wallpaper stripes (y 6-52, x 200-500); y 54-62 beside it is the raw wallpaper
mk_surface() {
  _kjs "$FX const {Glass} = await import('file://'+Main.extensionManager.lookup('guava-os@blueyzx64').dir.get_path()+'/lib/glass.js');
const t = new St.Widget({name:'b41-test', x:200, y:6, width:300, height:46}); Main.uiGroup.add_child(t);
globalThis.__T = t; globalThis.__TH = Glass.attach(t, {surface:'dock', role:'content', radius:12}); await sl(2000); return 1" >/dev/null
}
rm_surface() { _kjs 'globalThis.__TH.destroy(); globalThis.__T.destroy(); return 1' >/dev/null; }
mk_surface
assert test-surface-frost "(()=>{ $FX const f=fx(globalThis.__T); return f?.enabled && !!f._out && globalThis.__T.has_style_class_name('guava-glass-frost'); })()"
shot frost-surface-stripes
RAW=$(grad frost-surface-stripes 220 54 260 8)
BAR=$(grad frost-surface-stripes 220 36 260 14)
echo "gradient raw=$RAW surface=$BAR"
num_assert frost-surface-is-blurred "$BAR" "<" "$(awk -v r="$RAW" 'BEGIN{print r*0.4}')"
gsettings set org.gnome.shell.extensions.guava-os glass-reduce-transparency true; sleep 1.5
assert reduce-transparency-opaque "(()=>{ $FX const f=fx(globalThis.__T); return !f || f._look.top[3] === 1; })()"
shot frost-surface-solid
num_assert frost-differs-from-solid "$(diffpx frost-surface-stripes frost-surface-solid 220 36 260 14)" ">" 8
gsettings reset org.gnome.shell.extensions.guava-os glass-reduce-transparency; sleep 1.5
rm_surface

echo "-- liquid-glass on: today's look"
gs liquid-glass true; sleep 2
assert liquid-class "!Main.panel.has_style_class_name('guava-glass-frost') && Main.panel.has_style_class_name('guava-glass')"
assert liquid-saturation-boost "(()=>{ $FX return fx(Main.panel)._look.blur.saturation > 1.2; })()"
assert liquid-gradient-fill "(()=>{ $FX const l=fx(Main.panel)._look; return l.top.join() !== l.bottom.join(); })()"
shot liquid-bar
_kjs "$FX cc().open(); await sl(1200); return 1" >/dev/null
assert liquid-cc-has-rim "(()=>{ $FX const b=cc().box; return fx(b)?.enabled && /inset 0 1px 0 0/.test(b.style) && !b.has_style_class_name('guava-glass-frost'); })()"
_kjs "$FX cc().close(); await sl(500); dm().open(); await sl(1200); return 1" >/dev/null
shot liquid-menu-over-window
_kjs "$FX dm().close(); await sl(500); return 1" >/dev/null
shot liquid-dock
mk_surface
shot liquid-surface-stripes
RAWL=$(grad liquid-surface-stripes 220 54 260 8)
BARL=$(grad liquid-surface-stripes 220 36 260 14)
echo "gradient liquid raw=$RAWL surface=$BARL"
num_assert liquid-surface-is-blurred "$BARL" "<" "$(awk -v r="$RAWL" 'BEGIN{print r*0.4}')"
assert liquid-surface-saturated "(()=>{ $FX return fx(globalThis.__T)._look.blur.saturation > 1.2; })()"
rm_surface
gsettings reset org.gnome.shell.extensions.guava-os liquid-glass
assert_summary
