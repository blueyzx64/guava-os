# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh).
# B13 pointer: shaking with no button makes the pointer big; shaking while a window is dragged
#     (button held, a compositor grab) never does, and neither does motion right after the
#     release; disabling Guava gives cursor-size and cursor-theme back.
cat > $W/ptrapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.PtrApp'});
app.connect('activate',()=>{
  const w=new Gtk.ApplicationWindow({application:app,title:'Ptr App',default_width:600,default_height:400});
  w.set_titlebar(new Gtk.HeaderBar()); w.set_child(new Gtk.Label({label:'drag me'})); w.present();
});
app.run([]);
EOF2
launch_app "gjs $W/ptrapp.js" org.x2.PtrApp 40
sleep 2; focus_app org.x2.PtrApp; sleep 1
iface() { gsettings get org.gnome.desktop.interface "$1"; }
# shake(x, y): six quick 200 px strokes at 2 px/ms from x,y. The button state is the caller's.
SH='const shake=async(x,y)=>{kvp.notify_absolute_motion(kus(),x,y);await sl(30);let d=1;for(let s=0;s<6;s++){for(let i=1;i<=10;i++){kvp.notify_absolute_motion(kus(),x+d*20*i,y);await sl(8);}x+=d*200;d=-d;}};
const P_=()=>inst("pointer").state;'
J() { _kjs "$SH $1"; }

echo "-- B13 pointer shake"
assert "pointer feature runs" "inst('pointer')"
J 'await kmove(300,500); await sl(1200); await shake(300,500); await sl(250); return 1' >/dev/null
assert "shake with no button: big pointer shows" "inst('pointer').state.big"
# The big pointer is drawn from the theme's real large image, not a scaled-up sprite (B13 crispness)
assert "big pointer uses the theme's large image" "inst('pointer')._hi !== null && inst('pointer')._big?.content instanceof St.ImageContent"
shot pointer-shake-big
J 'await sl(1800); return 1' >/dev/null
assert "big pointer shrinks away after the shake" "!inst('pointer').state.big"

# Drag the window by its titlebar and shake while the button is held (a real grab)
J 'const w=kwin("org.x2.PtrApp"); const f=w.get_frame_rect(); const x=f.x+Math.round(f.width/3), y=f.y+18;
   await kmove(x,y); await kmove(x+1,y); await kmove(x,y); await sl(100); await kpress(); await sl(100);
   globalThis.__ptrSeen=false;
   for (let rep=0; rep<2; rep++) { await shake(x+200,y+100); if (P_().big) globalThis.__ptrSeen=true; }
   globalThis.__ptrGrab=global.display.is_grabbed();
   await krelease(); return 1' >/dev/null
assert "the drag was a real grab" "globalThis.__ptrGrab === true"
assert "shaking while dragging a window: no big pointer" "globalThis.__ptrSeen === false && !inst('pointer').state.big"
# Right after the release, a little motion must not complete a shake the drag began
J 'await sl(100); await kmove(700,500); await kmove(740,500); await kmove(700,500); await sl(300); return 1' >/dev/null
assert "no big pointer right after the release" "!inst('pointer').state.big"

# A shake in free space after all that still works (the detector is not stuck)
J 'await kmove(300,600); await sl(1200); await shake(300,600); await sl(250); return 1' >/dev/null
assert "shake works again after a drag" "inst('pointer').state.big"
J 'await sl(1800); return 1' >/dev/null

# Disable gives cursor-size and cursor-theme back
before_size=$(iface cursor-size); before_theme=$(iface cursor-theme)
gs pointer-size "'64'"; sleep 1
[ "$(iface cursor-size)" = 64 ] && echo "ASSERT PASS pointer size owned 64" || echo "ASSERT FAIL pointer size owned $(iface cursor-size)"
gs pointer-custom-colors true; sleep 5
t=$(iface cursor-theme)
case "$t" in *Guava-Pointer-*) echo "ASSERT PASS pointer theme owned $t";; *) echo "ASSERT FAIL pointer theme owned $t";; esac
DX="gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions"
$DX.DisableExtension guava-os@blueyzx64 >/dev/null 2>&1; sleep 2
if [ "$(iface cursor-size)" = "$before_size" ] && [ "$(iface cursor-theme)" = "$before_theme" ]; then
  echo "ASSERT PASS disable restores cursor-size $before_size and cursor-theme $before_theme"
else echo "ASSERT FAIL disable left size $(iface cursor-size) theme $(iface cursor-theme)"; fi
$DX.EnableExtension guava-os@blueyzx64 >/dev/null 2>&1; sleep 3
gs pointer-custom-colors false; gs pointer-size "'system'"; sleep 2
assert_summary
