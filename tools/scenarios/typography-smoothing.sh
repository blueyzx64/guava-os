# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh).
# B19: font-rendering 'automatic' makes GTK4 ignore font-hinting; Guava owns 'manual'.
# B20: Font Smoothing (FreeType stem darkening through ~/.config/environment.d/60-guava-freetype.conf)
#      makes text heavier in a GTK3 and a GTK4 app, measured by pixels (ink of the same text).
# The harness has no systemd user manager: an app started with the variables the file sets is what
# a fresh login hands every app, so the apps are launched with the file's FREETYPE_PROPERTIES.
TXT='Hamburgefonstiv illumination, the quick brown fox 0123456789'
cat > $W/ta3.js <<EOF2
imports.gi.versions.Gtk='3.0';
const {Gtk,Pango,GLib}=imports.gi;
GLib.set_prgname('org.x2.TA3');
Gtk.init(null);
const w=new Gtk.Window({title:'TA3',default_width:640,default_height:240});
const l=new Gtk.Label({label:'$TXT'});
l.override_font(Pango.FontDescription.from_string('${FONT:-Noto Sans} 14'));
w.add(l); w.connect('destroy',()=>Gtk.main_quit()); w.show_all(); Gtk.main();
EOF2
cat > $W/ta4.js <<EOF2
imports.gi.versions.Gtk='4.0';
const {Gtk,Pango}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.TA4'});
app.connect('activate',()=>{
  const w=new Gtk.ApplicationWindow({application:app,title:'TA4',default_width:640,default_height:240});
  const l=new Gtk.Label({label:'$TXT'});
  const a=Pango.AttrList.new(); a.insert(Pango.attr_font_desc_new(Pango.FontDescription.from_string('${FONT:-Noto Sans} 14')));
  l.set_attributes(a); w.set_child(l); w.present();
});
app.run([]);
EOF2
# ink.js SHOT X Y W H: total ink (difference from the corner pixel, in whole-pixel units) and a content hash
cat > $W/ink.js <<'EOF2'
imports.gi.versions.GdkPixbuf='2.0';
const {GdkPixbuf,GLib}=imports.gi;
const [f,x0,y0,w,h]=[ARGV[0],...ARGV.slice(1).map(Number)];
const p=GdkPixbuf.Pixbuf.new_from_file(f), n=p.get_n_channels(), rs=p.get_rowstride(), px=p.get_pixels();
const lum=(x,y)=>{const o=y*rs+x*n; return (px[o]+px[o+1]+px[o+2])/3;};
const bg=lum(x0,y0); let s=0;
for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++)s+=Math.abs(lum(x,y)-bg);
const rows=[];for(let y=y0;y<y0+h;y++)rows.push(Array.from(px.subarray(y*rs+x0*n,y*rs+(x0+w)*n)).join(','));
print('INK '+(s/255).toFixed(1)+' '+GLib.compute_checksum_for_string(GLib.ChecksumType.MD5,rows.join(';'),-1).slice(0,8));
EOF2
iface() { gsettings set org.gnome.desktop.interface "$@"; }
envfile=$HOME/.config/environment.d/60-guava-freetype.conf

# measure KIND(3|4) NAME ENVSTRING: launch the app (with ENVSTRING), screenshot, print "INK n hash"
measure() {
  local kind=$1 name=$2 envs=$3 cls r g
  cls=org.x2.TA$kind
  launch_app "env $envs gjs $W/ta$kind.js" "$cls" 40 >/dev/null
  sleep 1.5
  g=$(_kjs "const w=kwin('$cls'); w.move_frame(true,100,100); await sl(300); const f=w.get_frame_rect(); return [f.x,f.y,f.width,f.height].join(' ')" | grep -o '[0-9-]\+ [0-9-]\+ [0-9]\+ [0-9]\+')
  set -- $g
  shot "$name" >/dev/null
  r=$(gjs $W/ink.js /opt/shots/$name.png $(( $1 + 40 )) $(( $2 + 70 )) $(( $3 - 80 )) $(( $4 - 100 )) 2>/dev/null | grep INK)
  # kill() ends exactly this window's client (no pattern kill: the roots share the host's PIDs)
  _kjs "kwin('$cls')?.kill(); return 1" >/dev/null
  sleep 1
  echo "$r"
}
inkval() { echo "$1" | awk '{print $2}'; }
inkhash() { echo "$1" | awk '{print $3}'; }
ratio() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.3f", a/b}'; }
chk() { # NAME CONDITION(shell test)
  if eval "$2"; then echo "ASSERT PASS $1"; GUAVA_ASSERT_PASS=$((GUAVA_ASSERT_PASS+1)); else echo "ASSERT FAIL $1"; GUAVA_ASSERT_FAIL=$((GUAVA_ASSERT_FAIL+1)); fi; }

echo "-- B19 Guava owns font-rendering manual"
sleep 2
chk "font-rendering is manual while Guava runs" '[ "$(gsettings get org.gnome.desktop.interface font-rendering)" = "'"'manual'"'" ]'
chk "smoothing on: hinting slight" '[ "$(gsettings get org.gnome.desktop.interface font-hinting)" = "'"'slight'"'" ]'
gs macos-font-smoothing false; sleep 1.5
chk "smoothing off: hinting none" '[ "$(gsettings get org.gnome.desktop.interface font-hinting)" = "'"'none'"'" ]'
chk "smoothing off: file removed" '[ ! -e "$envfile" ]'

echo "-- B19 pixels: GTK4 follows font-hinting only under manual (Guava rendering part off, keys set by hand)"
gs macos-text-rendering false; sleep 1.5
iface font-rendering automatic; iface font-antialiasing grayscale
iface font-hinting none;  A_NONE=$(measure 4 b19-auto-none "A=1")
iface font-hinting full;  A_FULL=$(measure 4 b19-auto-full "A=1")
iface font-rendering manual
iface font-hinting none;  M_NONE=$(measure 4 b19-manual-none "A=1")
iface font-hinting full;  M_FULL=$(measure 4 b19-manual-full "A=1")
echo "B19 automatic none=$A_NONE full=$A_FULL | manual none=$M_NONE full=$M_FULL"
chk "GTK4 automatic: hinting key changes nothing (the bug)" '[ "$(inkhash "$A_NONE")" = "$(inkhash "$A_FULL")" ]'
chk "GTK4 manual: hinting key changes the text (the fix)" '[ "$(inkhash "$M_NONE")" != "$(inkhash "$M_FULL")" ]'
gs macos-text-rendering true; sleep 1.5

echo "-- B20 file lifecycle"
gs macos-font-smoothing true; sleep 2
chk "file written (Guava marker)" 'grep -q "^# Managed by Guava OS" "$envfile" && grep -q "^FREETYPE_PROPERTIES=.*no-stem-darkening=0" "$envfile"'
FP=$(grep '^FREETYPE_PROPERTIES=' "$envfile" | cut -d= -f2-)
gs macos-font-smoothing false; sleep 1.5
chk "file removed when off" '[ ! -e "$envfile" ]'
printf 'FREETYPE_PROPERTIES=mine\n' > "$envfile"
gs macos-font-smoothing true; sleep 1.5
chk "foreign file never overwritten" '[ "$(cat "$envfile")" = "FREETYPE_PROPERTIES=mine" ]'
gs macos-font-smoothing false; sleep 1.5
chk "foreign file never removed" '[ "$(cat "$envfile")" = "FREETYPE_PROPERTIES=mine" ]'
rm -f "$envfile"; gs macos-font-smoothing true; sleep 1.5
chk "file written again after a foreign file is gone" '[ -s "$envfile" ]'
[ -n "$FP" ] || FP=$(grep '^FREETYPE_PROPERTIES=' "$envfile" | cut -d= -f2-)

echo "-- B20 pixels: heavier text in GTK3 and GTK4 (Noto Sans, TrueType)"
gs macos-font-smoothing false; sleep 1.5
OFF4=$(measure 4 b20-gtk4-off "A=1"); OFF3=$(measure 3 b20-gtk3-off "A=1")
gs macos-font-smoothing true; sleep 1.5
ON4=$(measure 4 b20-gtk4-on "FREETYPE_PROPERTIES='$FP'"); ON3=$(measure 3 b20-gtk3-on "FREETYPE_PROPERTIES='$FP'")
R4=$(ratio "$(inkval "$ON4")" "$(inkval "$OFF4")"); R3=$(ratio "$(inkval "$ON3")" "$(inkval "$OFF3")")
echo "B20 GTK4 off=$OFF4 on=$ON4 ratio=$R4 | GTK3 off=$OFF3 on=$ON3 ratio=$R3"
chk "GTK4 text heavier with smoothing (ink x$R4 >= 1.10)" 'awk -v r="$R4" "BEGIN{exit !(r>=1.10)}"'
chk "GTK3 text heavier with smoothing (ink x$R3 >= 1.10)" 'awk -v r="$R3" "BEGIN{exit !(r>=1.10)}"'
# Control: slight hinting alone (variable unset) must not give the weight: the variable is what darkens
gs macos-font-smoothing true
CTL4=$(measure 4 b20-gtk4-slight-noenv "A=1")
echo "B20 control GTK4 slight hinting without the variable=$CTL4"
chk "the variable, not slight hinting, makes it heavier" 'awk -v a="$(inkval "$ON4")" -v b="$(inkval "$CTL4")" "BEGIN{exit !(a/b>=1.08)}"'
assert_summary
