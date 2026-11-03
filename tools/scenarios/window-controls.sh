# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh).
# B12 the green button: maximize button -> full screen, again -> windowed; Super+Up and a
#     titlebar double-click still maximize; the preference off gives GNOME's maximize back.
force_animations on
cat > $W/btnapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk,GLib}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.BtnApp'});
const find=(w,cls)=>{ if(w.has_css_class?.(cls)) return w; for(let c=w.get_first_child();c;c=c.get_next_sibling()){const r=find(c,cls); if(r) return r;} return null; };
app.connect('activate',()=>{
  const w=new Gtk.ApplicationWindow({application:app,title:'Btn App',default_width:700,default_height:450});
  w.set_titlebar(new Gtk.HeaderBar()); w.set_child(new Gtk.Label({label:'buttons'})); w.present();
  // Writes the maximize button's surface rect; runs a command the scenario drops in cmd.txt
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, ()=>{
    const b=find(w,'maximize'); const out={fs:w.is_fullscreen(),max:w.is_maximized()};
    if(b?.get_mapped()){const [,r]=b.compute_bounds(w); const [sx,sy]=w.get_native().get_surface_transform(); out.btn=[Math.round(r.get_x()+sx+r.get_width()/2),Math.round(r.get_y()+sy+r.get_height()/2)];}
    GLib.file_set_contents('/tmp/w/btn.json', JSON.stringify(out));
    try { const [ok,c]=GLib.file_get_contents('/tmp/w/cmd.txt'); GLib.unlink('/tmp/w/cmd.txt'); if(new TextDecoder().decode(c).trim()==='max') w.maximize(); } catch(e) {}
    return GLib.SOURCE_CONTINUE; });
});
app.run([]);
EOF2
launch_app "gjs $W/btnapp.js" org.x2.BtnApp 40
sleep 2; focus_app org.x2.BtnApp; sleep 2
H='const W=()=>kwin("org.x2.BtnApp"); const st=()=>JSON.parse(new TextDecoder().decode(GLib.file_get_contents("/tmp/w/btn.json")[1]));
const btn=()=>{const b=W().get_buffer_rect(); const j=st(); return j.btn?[b.x+j.btn[0], b.y+j.btn[1]]:null;};
const state=()=>`max=${W().is_maximized()} fs=${W().is_fullscreen()}`;'
J() { _kjs "$H $1"; }

echo "-- B12 green button"
J 'const p=btn(); await kclick(p[0],p[1]); await sl(1500); return 1' >/dev/null
assert "green button enters full screen" "kwin('org.x2.BtnApp').is_fullscreen() && !kwin('org.x2.BtnApp').is_maximized()"
shot wc1-fullscreen
# In full screen GTK hides the headerbar; the app's own maximize request (what its button sends)
# with the pointer on the button band leaves full screen
J 'const m=Main.layoutManager.primaryMonitor; await kmove(m.x+m.width-30, m.y+20); GLib.file_set_contents("/tmp/w/cmd.txt","max"); await sl(1800); return 1' >/dev/null
assert "green button in full screen leaves full screen, windowed" "!kwin('org.x2.BtnApp').is_fullscreen() && !kwin('org.x2.BtnApp').is_maximized() && kwin('org.x2.BtnApp').get_frame_rect().width < 1000"
J 'await kmove(640,600); await sl(200); return 1' >/dev/null
key super+Up; sleep 1.5
assert "Super+Up still maximizes" "kwin('org.x2.BtnApp').is_maximized() && !kwin('org.x2.BtnApp').is_fullscreen()"
J 'const p=btn(); await kclick(p[0],p[1]); await sl(1500); return 1' >/dev/null
assert "green button on a zoomed window enters full screen" "kwin('org.x2.BtnApp').is_fullscreen()"
J 'W().unmake_fullscreen(); await sl(1500); return 1' >/dev/null
assert "leaving full screen returns to zoomed" "kwin('org.x2.BtnApp').is_maximized() && !kwin('org.x2.BtnApp').is_fullscreen()"
key super+Down; sleep 1.5
J 'const f=W().get_frame_rect(); const x=f.x+Math.round(f.width/2), y=f.y+18; await kmove(x,y); await kmove(x+1,y); await kmove(x,y); await sl(100); const t=()=>GLib.get_monotonic_time(); kvp.notify_button(t(),1,Clutter.ButtonState.PRESSED); await sl(30); kvp.notify_button(t(),1,Clutter.ButtonState.RELEASED); await sl(60); kvp.notify_button(t(),1,Clutter.ButtonState.PRESSED); await sl(30); kvp.notify_button(t(),1,Clutter.ButtonState.RELEASED); await sl(1500); return 1' >/dev/null
assert "titlebar double-click still maximizes (Zoom)" "kwin('org.x2.BtnApp').is_maximized() && !kwin('org.x2.BtnApp').is_fullscreen()"
J 'W().unmaximize(); await sl(1200); return 1' >/dev/null
gs windows-green-button-fullscreen false; sleep 1
J 'const p=btn(); await kclick(p[0],p[1]); await sl(1500); return 1' >/dev/null
assert "preference off: maximize button maximizes" "kwin('org.x2.BtnApp').is_maximized() && !kwin('org.x2.BtnApp').is_fullscreen()"
J 'W().unmaximize(); await sl(1200); return 1' >/dev/null
gs windows-green-button-fullscreen true; sleep 1

assert_summary
