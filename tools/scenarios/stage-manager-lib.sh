# Stage Manager scenario helpers (GUAVA_EXTRA; bundle after lib.sh and perf-lib.sh, before the
# stage-manager-*.sh scenarios). Spec: docs/features/stage-manager.md (SM-n).
#   K=tools/harness/lib; S=$(mktemp -d)
#   $K/bundle.sh $S/extra.sh $K/lib.sh $K/perf-lib.sh $K/classify.js \
#       tools/scenarios/stage-manager-lib.sh tools/scenarios/stage-manager-{sets,minimize,maximize,strip,lifecycle}.sh
# This file runs no assertions itself.
#
# Test apps: three GTK4 windows org.x2.SmA/SmB/SmC titled "SM A".."SM C", driven through a command
# file ($W/<id>.cmd: min, max, unmax, close, newwin, quit) and reporting their header buttons in
# $W/<id>.json (surface coordinates of the minimize and maximize buttons).

cat > $W/smapp.js <<'EOF2'
imports.gi.versions.Gtk='4.0';
const {Gtk,GLib}=imports.gi;
const id=imports.system.programArgs[0];
const label=id.slice(-1);
const app=new Gtk.Application({application_id:id});
const find=(w,cls)=>{ if(w.has_css_class?.(cls)) return w; for(let c=w.get_first_child();c;c=c.get_next_sibling()){const r=find(c,cls); if(r) return r;} return null; };
let n=0;
const open=()=>{ n++; const w=new Gtk.ApplicationWindow({application:app,title:n>1?`SM ${label} ${n}`:`SM ${label}`,default_width:600,default_height:400});
  w.set_titlebar(new Gtk.HeaderBar()); w.set_child(new Gtk.Label({label:`app ${label}`})); w.present(); return w; };
app.connect('activate',()=>{
  const first=open();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT,200,()=>{
    const out={}; const w=app.get_active_window()??first;
    for(const k of ['minimize','maximize']){ const b=find(w,k); if(b?.get_mapped()){ const [,r]=b.compute_bounds(w); const [sx,sy]=w.get_native().get_surface_transform(); out[k]=[Math.round(r.get_x()+sx+r.get_width()/2),Math.round(r.get_y()+sy+r.get_height()/2)]; } }
    GLib.file_set_contents(`/tmp/w/${id}.json`, JSON.stringify(out));
    try { const [ok,c]=GLib.file_get_contents(`/tmp/w/${id}.cmd`); GLib.unlink(`/tmp/w/${id}.cmd`);
      const cmd=new TextDecoder().decode(c).trim(); const aw=app.get_active_window()??first;
      if(cmd==='min') aw.minimize(); else if(cmd==='max') aw.maximize(); else if(cmd==='unmax') aw.unmaximize();
      else if(cmd==='close') aw.close(); else if(cmd==='newwin') open(); else if(cmd==='quit') app.quit(); } catch(e) {}
    return GLib.SOURCE_CONTINUE; });
});
app.run([]);
EOF2

# JS helpers added to every P/assert/wait_for body
_SMH=$(cat <<'JS'
const aw=c=>global.get_window_actors().find(a=>(a.meta_window.get_wm_class()||"").toLowerCase()===String(c).toLowerCase())??null;
const sid=x=>"org.x2.Sm"+x;
// state of an app window: min = Mutter minimized, op = actor opacity
const wst=c=>{const a=aw(c); if(!a) return null; const w=a.meta_window; return {min:w.minimized,op:a.opacity,vis:a.visible,mapped:a.mapped,react:a.reactive,fs:w.is_fullscreen(),max:w.is_maximized(),ws:w.get_workspace()?.index()};};
const under=(a,p)=>{for(let x=p;x;x=x.get_parent()) if(x===a) return true; return false;};
// the window is what a click at the centre of its frame hits
const pickable=c=>{const a=aw(c); if(!a) return false; const f=a.meta_window.get_frame_rect(); return under(a, global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, f.x+f.width/2, f.y+f.height/2));};
// on the stage: visible, opaque, clickable, not minimized
const onStage=c=>{const s=wst(c); return !!s && !s.min && s.op===255 && s.vis && s.mapped && pickable(c);};
// off the stage: not minimized (it lives in the strip), invisible
const inStrip=c=>{const s=wst(c); return !!s && !s.min && s.op===0;};
// as GNOME would have it without Stage Manager
const restored=c=>{const s=wst(c); return !!s && s.op===255 && s.vis && s.mapped;};
const walk=(a,f)=>{ if(f(a)) return a; for(const c of a.get_children()){const r=walk(c,f); if(r) return r;} return null; };
const strip=()=>walk(global.stage,a=>a.has_style_class_name?.("guava-stage-strip"));
const cards=()=>{const o=[]; walk(global.stage,a=>{ if(a.has_style_class_name?.("guava-stage-card")) o.push(a); return false;}); return o;};
const cardOf=t=>cards().find(c=>{const n=c.accessible_name||""; return n.includes(t)||n.includes("org.x2.Sm"+t.slice(-1));});
const flight=()=>walk(global.stage,a=>a.name==="guava-stage-flight");
// strip on screen: mapped, opaque and its right edge past the monitor edge
const stripShown=()=>{const s=strip(); if(!s||!s.mapped||!s.visible) return false; let o=1; for(let x=s;x;x=x.get_parent()) o*=x.opacity/255; const [x]=s.get_transformed_position(); return o>0.5 && x+s.width>4;};
const m0=Main.layoutManager.primaryMonitor;
// pointer pushes the left edge: relative motion into the clamped edge
const kpush=async(n=6,y=400)=>{await kmove(m0.x+40,y); await kmove(m0.x+1,y); for(let i=0;i<n;i++){kvp.notify_relative_motion(kus(),-30,0); await sl(40);} };
JS
)
_KJS_PRE="$_KJS_PRE
$_SMH"

# sm_up X...: stage manager on, animations on, the apps launched in order (the last is the stage)
sm_up() {
  force_animations on
  gs stage-manager true; sleep 1
  for x in "$@"; do
    rm -f $W/org.x2.Sm$x.cmd
    launch_app "gjs $W/smapp.js org.x2.Sm$x" org.x2.Sm$x 40
    sleep 2
  done
}
# sm_cmd X CMD: send a command to app X
sm_cmd() { echo "$2" > $W/org.x2.Sm$1.cmd; sleep 1; }
# sm_down: quit the test apps and wait until their windows are gone
sm_down() {
  for x in A B C; do echo quit > $W/org.x2.Sm$x.cmd; done
  wait_for "!aw('org.x2.SmA') && !aw('org.x2.SmB') && !aw('org.x2.SmC')" 15 >/dev/null; sleep 1
}
# sm_state: one greppable line of what each test window looks like
sm_state() {
  _kjs 'return "STATE "+["A","B","C"].map(x=>{const s=wst(sid(x)); return s?`${x}:op${s.op}${s.min?":MIN":""}${s.max?":MAX":""}${s.fs?":FS":""}${s.react?"":":!react"}${pickable(sid(x))?":pick":""}`:x+":none"}).join(" ")+" strip="+stripShown()+" cards="+cards().length' | grep -o "STATE.*" | head -1
}
