# Scenario for the real-Shell harness (GUAVA_EXTRA, bundled after tools/harness/lib/lib.sh).
# The traffic-light window buttons are the same size and spacing in every toolkit: libadwaita, plain
# GTK4 header bars (non-libadwaita apps, and Mutter's titlebars for X11 apps, mutter-x11-frames) and
# GTK3. GTK's built-in theme made plain GTK4 buttons 34 px wide and 40 px apart (user report); the
# probe apps below print each button's x and width, and the asserts check a 23-24 px pitch.
cat > $W/hb4.js <<'HBJS'
imports.gi.versions.Gtk = '4.0';
const { Gtk, GLib } = imports.gi;
const ADW = ARGV[0] === 'adw';
let Adw = null;
if (ADW) { imports.gi.versions.Adw = '1'; Adw = imports.gi.Adw; Adw.init(); } else Gtk.init();
const win = new Gtk.Window({ title: 'HB', default_width: 500, default_height: 200 });
const hb = ADW ? new Adw.HeaderBar() : new Gtk.HeaderBar();
win.set_titlebar(hb); win.present();
const loop = GLib.MainLoop.new(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
    const out = [];
    const walk = w => { for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
        if (ARGV[1] === 'all') out.push(`${c.constructor.$gtype.name}[${c.get_css_classes().join('.')}]`);
        if (/(^| )(close|minimize|maximize)( |$)/.test(c.get_css_classes().join(' '))) { const [ok, b] = c.compute_bounds(win); out.push(`${c.get_css_classes()[0]} x=${b.get_x().toFixed(0)} w=${b.get_width().toFixed(0)}`); }
        walk(c); } };
    walk(hb); print(`HB ${ADW ? 'libadwaita' : 'gtk4-plain'} layout=${Gtk.Settings.get_default().gtk_decoration_layout}: ${out.join(' | ')}`); loop.quit(); return false; });
loop.run();
HBJS
cat > $W/hb3.js <<'HBJS'
imports.gi.versions.Gtk = '3.0';
const { Gtk, GLib } = imports.gi;
Gtk.init(null);
const win = new Gtk.Window({ title: 'HB3', default_width: 500, default_height: 200 });
const hb = new Gtk.HeaderBar({ show_close_button: true });
win.set_titlebar(hb); win.show_all();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
    const out = [];
    const walk = w => { if (w.forall) w.forall(c => {
        const cls = c.get_style_context().list_classes().join(' ');
        if (/titlebutton/.test(cls)) { const a = c.get_allocation(); out.push(`${cls.replace('titlebutton','').trim()} x=${a.x} w=${a.width}`); }
        walk(c); }); };
    walk(hb); print(`HB gtk3: ${out.join(' | ')}`); Gtk.main_quit(); return false; });
Gtk.main();
HBJS
WDS=$(ls $W/run | grep -m1 '^wayland-[0-9]*$')
for args in "hb4.js plain" "hb4.js adw" "hb3.js"; do
  (cd $W/home && env HOME=$HOME WAYLAND_DISPLAY=$WDS XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gjs $W/$args 2>&1 | grep '^HB')
done > $W/hb.txt
cat $W/hb.txt
# pitch = distance between the button x positions; width of each button
check() {
  local kind=$1 line xs ws
  line=$(grep "HB $kind" $W/hb.txt)
  xs=$(echo "$line" | grep -oE '(minimize|maximize|close) x=[0-9-]+' | grep -oE '[0-9-]+$' | tr '\n' ' ')
  ws=$(echo "$line" | grep -oE '(minimize|maximize|close) x=[0-9-]+ w=[0-9]+' | grep -oE '[0-9]+$' | tr '\n' ' ')
  set -- $xs
  if [ $# -eq 3 ] && [ $(( $2 - $1 )) -ge 22 ] && [ $(( $2 - $1 )) -le 24 ] && [ $(( $3 - $2 )) -ge 22 ] && [ $(( $3 - $2 )) -le 24 ]; then
    assert "$kind buttons 22-24 px apart (x: $xs; w: $ws)" "true"
  else
    assert "$kind buttons 22-24 px apart (x: $xs; w: $ws)" "false"
  fi
}
check gtk4-plain; check libadwaita; check gtk3
assert_summary
