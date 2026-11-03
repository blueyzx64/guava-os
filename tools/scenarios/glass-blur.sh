# Scenario (GUAVA_EXTRA): Liquid Glass (liquid-glass on) real blur (B3) and the menu bar leaving Mission Control (B15).
# Bundle: K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh $K/perf-lib.sh $K/classify.js tools/scenarios/glass-blur.sh
#   - a detailed test wallpaper (stripes, circles, text) so blur is visible in the screenshots
#   - the blur effect is attached and has captured a backdrop (menu bar, Control Center)
#   - the bar's glass presence equals 1 - overview progress on every frame: open, close, and an
#     open interrupted by a close (max deviation), plus JITTER of the close
#   - frame times of a window drag with glass on and off, and a Control Center open/close
cat > $W/mkwall.js <<'JS'
const Cairo = imports.cairo;
const W = 1280, H = 800;
const s = new Cairo.ImageSurface(Cairo.Format.RGB24, W, H);
const c = new Cairo.Context(s);
const g = new Cairo.LinearGradient(0, 0, W, H);
g.addColorStopRGB(0, 0.95, 0.45, 0.20); g.addColorStopRGB(0.5, 0.55, 0.20, 0.75); g.addColorStopRGB(1, 0.10, 0.45, 0.85);
c.setSource(g); c.paint();
for (let i = 0; i < 64; i++) { c.setSourceRGBA(i % 2, 1, (i % 3) / 2, 0.9); c.rectangle(i * 20, 0, 10, 60); c.fill(); }
for (let i = 0; i < 40; i++) { c.setSourceRGBA((i * 37 % 255) / 255, (i * 91 % 255) / 255, (i * 53 % 255) / 255, 0.95); c.arc((i * 151) % W, 80 + (i * 97) % (H - 120), 18 + (i % 5) * 14, 0, 6.283); c.fill(); }
c.setSourceRGB(1, 1, 1); c.rectangle(0, 700, W, 100); c.fill();
c.setSourceRGB(0, 0, 0); c.selectFontFace('Sans', 0, 1); c.setFontSize(40);
for (let i = 0; i < 5; i++) { c.moveTo(20 + i * 250, 760); c.showText('GUAVA ' + i); }
s.writeToPNG(ARGV[0]);
JS
gjs $W/mkwall.js $W/wall.png
gsettings set org.gnome.desktop.background picture-uri "file://$W/wall.png"
gsettings set org.gnome.desktop.background picture-uri-dark "file://$W/wall.png"
force_animations on
# Liquid Glass is off by default (B41, glass-frost.sh covers the default look): this scenario is about the glass look
gs liquid-glass true
sleep 2
FX='const fx=a=>a?.get_effect?.("guava-glass")??null; const cc=()=>Main.panel.statusArea.quickSettings.menu;'
# warm-up: shaders and the first overview frame
_kjs 'Main.overview.show(); await sl(900); Main.overview.hide(); await sl(1800); return 1' >/dev/null
assert glass-effect-on-bar "Main.panel.get_effect('guava-glass')?.enabled === true"
_kjs "$FX cc().open(); await sl(1200); return 1" >/dev/null
assert glass-cc-blurred "(()=>{ $FX const f=fx(cc().box); return f?.enabled && !!f._out && f._key !== ''; })()"
shot glass-cc-dark
_kjs "$FX cc().close(); await sl(500); Main.panel.statusArea.dateMenu.menu.open(); await sl(1200); return 1" >/dev/null
shot glass-date-dark
_kjs 'Main.panel.statusArea.dateMenu.menu.close(); await sl(500); return 1' >/dev/null
gsettings set org.gnome.desktop.interface color-scheme prefer-light; sleep 1.5
_kjs "$FX cc().open(); await sl(1200); return 1" >/dev/null
shot glass-cc-light
_kjs "$FX cc().close(); await sl(500); return 1" >/dev/null
gsettings set org.gnome.desktop.interface color-scheme default; sleep 1.5
perf_start; _kjs "$FX cc().open(); await sl(900); cc().close(); await sl(700); return 1" >/dev/null; perf_stop glass-cc-open-close

echo "-- B15: the bar's glass follows the overview"
gs menubar-solid-on-window true; sleep 1
_kjs 'const w=kwin("org.gnome.TextEditor"); w.activate(global.get_current_time()); w.maximize(); await sl(1500); return 1' >/dev/null
shot glass-bar-solid
# per frame: deviation of presence from 1 - clamp(overview progress)
_kjs 'const adj=Main.overview._overview.controls._stateAdjustment;
const st={max:0,n:0,id:0}; st.id=global.stage.connect("after-paint",()=>{const f=Main.panel.get_effect("guava-glass"); if(!f) return;
 const want=1-Math.min(1,Math.max(0,adj.value)); st.max=Math.max(st.max,Math.abs(f.presence*1-want)); st.n++;}); globalThis.__b15=st; return 1' >/dev/null
PR="({get_transformed_position:()=>[0,0],get_transformed_size:()=>[1280,32],get_paint_visibility:()=>true,opacity:Math.round(255*(Main.panel.get_effect('guava-glass')?.presence??0)),scale_x:1,scale_y:1})"
perf_start
track_actor "$PR" b15-bar-open; _kjs 'Main.overview.show(); await sl(900); return 1' >/dev/null; track_stop
track_actor "$PR" b15-bar-close; _kjs 'Main.overview.hide(); await sl(900); return 1' >/dev/null; track_stop
perf_stop b15-overview
_kjs 'Main.overview.show(); await sl(120); Main.overview.hide(); await sl(900); return 1' >/dev/null
assert b15-presence-follows-overview "(()=>{const s=globalThis.__b15; global.stage.disconnect(s.id); return s.n>10 && s.max<0.02})()"
_kjs 'const s=globalThis.__b15; return "B15 frames="+s.n+" maxDeviation="+s.max.toFixed(4)' | grep -o "B15 [^'\"]*"
assert b15-bar-solid-after "Main.panel.get_effect('guava-glass')?.presence === 1"
_kjs 'const w=kwin("org.gnome.TextEditor"); w.unmaximize(); await sl(1000); return 1' >/dev/null
gs menubar-solid-on-window false; sleep 1

echo "-- cost: window drag with glass on and off"
DRAG='const w=kwin("org.gnome.TextEditor"); w.move_frame(true, 300, 150); await sl(500); const r=w.get_frame_rect(); const x=r.x+r.width/2, y=r.y+18; await kdrag(x,y,x+300,y+250,40); await kdrag(x+300,y+250,x,y,40); return 1'
perf_start; _kjs "$DRAG" >/dev/null; perf_stop drag-glass-on
_kjs 'const w=kwin("org.gnome.TextEditor"); const r=w.get_frame_rect(); await kdrag(r.x+r.width/2,r.y+18,r.x+r.width/2,r.y+318,30); await sl(800); return 1' >/dev/null
shot glass-dock-over-window
gs liquid-glass-surfaces '[]'; sleep 2
perf_start; _kjs "$DRAG" >/dev/null; perf_stop drag-glass-off
gs liquid-glass-surfaces "['panel', 'menus', 'dock', 'overlays']"; sleep 2
assert_summary
