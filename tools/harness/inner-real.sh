#!/bin/bash
# Inside the Arch chroot.
N=${1:-20}
W=/tmp/w; rm -rf $W; mkdir -p $W/home/.config $W/home/.cache $W/run; chmod 700 $W/run
UUID=guava-os@blueyzx64
X=$W/home/.local/share/gnome-shell/extensions
mkdir -p $X; cp -r /opt/guava-src $X/$UUID; cp -r /opt/probe/probe@x2 $X/
sed -i 's/"shell-version": \[/"shell-version": ["51","50","49",/' $X/$UUID/metadata.json
glib-compile-schemas $X/$UUID/schemas
mkdir -p /run/dbus
rm -f /run/dbus/system_bus_socket /run/dbus/pid; dbus-daemon --system --fork 2>&1
gjs /opt/fake-logind.js >$W/fake-logind.log 2>&1 &
sleep 1
cat >$W/session.sh <<'IN'
export HOME=$W/home XDG_CONFIG_HOME=$W/home/.config XDG_DATA_HOME=$W/home/.local/share XDG_CACHE_HOME=$W/home/.cache XDG_RUNTIME_DIR=$W/run GSETTINGS_BACKEND=keyfile
export GSETTINGS_SCHEMA_DIR=$X/$UUID/schemas
export XDG_SESSION_TYPE=wayland G_MESSAGES_DEBUG=
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID','probe@x2']"
gs() { gsettings set org.gnome.shell.extensions.guava-os "$@" 2>&1 || echo "gsettings fail $*"; }
SCHEMA=$(grep -o 'id="[^"]*"' $X/$UUID/schemas/*.xml | head -1); echo "schema: $SCHEMA"
# turn on the new features before start
ALL='notch liquid-glass control-center stage-manager clipboard-history spotlight show-window-controls show-window-title panel-styling popup-menu-styling'
[ -f /opt/guava-only ] && GUAVA_ONLY=$(cat /opt/guava-only)
if [ -n "$GUAVA_ONLY" ]; then for k in $ALL; do gs $k false; done; for k in $GUAVA_ONLY; do gs $k true; done; else for k in $ALL; do gs $k true; done; fi
# Optional per-agent setup before the Shell starts (GUAVA_PRE): mock system services, audio, ...
if [ -f /opt/guava-pre.sh ]; then echo "== PRE"; . /opt/guava-pre.sh; fi
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 >$W/shell.log 2>&1 &
SP=$!
sleep 8
P() { gdbus call --session --dest org.x2.Probe --object-path /org/x2/Probe --method org.x2.Probe.Eval "$1" 2>&1; }

T() { # T name js : js returns "PASS ..." or "FAIL ..."
  local r; r=$(P "$2"); case "$r" in *PASS*) echo "PROBE PASS $1 :: ${r:0:230}";; *) echo "PROBE FAIL $1 :: ${r:0:400}";; esac; }
SL='const sl=ms=>new Promise(r=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{r();return GLib.SOURCE_REMOVE})); const reg=Main.extensionManager.lookup("guava-os@blueyzx64").stateObj._features; const inst=id=>reg._state.get(id)?.instance;'
cat >$W/x2app.js <<'JSA'
imports.gi.versions.Gtk='4.0';
const {Gtk,GLib}=imports.gi;
const app=new Gtk.Application({application_id:'org.x2.TestB'});
app.connect('activate',()=>{const w=new Gtk.ApplicationWindow({application:app,title:'X2 second app',default_width:500,default_height:300});w.set_child(new Gtk.Label({label:'b'}));w.present();});
app.run([]);
JSA
for _ in $(seq 1 30); do P "return 1" 2>/dev/null | grep -q "1" && break; sleep 2; done; sleep 3
echo "== version"; P "return imports.misc.config.PACKAGE_VERSION"
P "return (await import('resource:///org/gnome/shell/misc/config.js')).PACKAGE_VERSION"
echo "== extension state"; P "const e=Main.extensionManager.lookup('guava-os@blueyzx64'); return [e?.state, e?.error]"
echo "== feature status"; P "const e=Main.extensionManager.lookup('guava-os@blueyzx64'); const f=e.stateObj._features; const o={}; for (const id of f._status.keys()) o[id]=f.status(id); return o"
echo "== panel boxes"; P "const d=a=>a.get_children().map(c=>c.constructor.name+'#'+(c.name||'')+'.'+(c.style_class||'')); return {left:d(Main.panel._leftBox),center:d(Main.panel._centerBox),right:d(Main.panel._rightBox)}"
echo "== chrome actors named guava*"; P "const o=[];const w=(a,dp)=>{ if((a.name||'').startsWith('guava')||(a.style_class||'').includes('guava')) o.push(a.constructor.name+'#'+a.name+' vis='+a.visible+' '+Math.round(a.width)+'x'+Math.round(a.height)); a.get_children().forEach(c=>w(c,dp+1)); }; w(global.stage,0); return o.slice(0,60)"
echo "== launch GTK app"
for _ in $(seq 1 60); do WD=$(ls $W/run 2>/dev/null | grep -m1 '^wayland-[0-9]*$'); [ -n "$WD" ] && P 'return 1' | grep -q 1 && break; sleep 1; done; echo "wayland socket: $WD"
# Let D-Bus-activated portals reach the compositor, like a real session (apps read button-layout via the Settings portal)
dbus-update-activation-environment WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland XDG_CURRENT_DESKTOP=GNOME GSETTINGS_BACKEND=keyfile HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME XDG_DATA_HOME=$XDG_DATA_HOME GSETTINGS_SCHEMA_DIR=$GSETTINGS_SCHEMA_DIR >/dev/null 2>&1
# A portal started before this has no display; restart it (and its gtk backend) so it re-activates with the env above
for n in org.freedesktop.portal.Desktop org.freedesktop.impl.portal.desktop.gtk org.freedesktop.impl.portal.desktop.gnome; do PID=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID $n 2>/dev/null | grep -o '[0-9]\+' | tail -1); [ -n "$PID" ] && kill $PID; done; sleep 1
# Wait until the restarted portal (and its gnome/gtk backends) answer, so apps never start against a half-up portal
for _ in $(seq 1 30); do gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.portal.Settings.ReadAll "['org.gnome.desktop.wm.preferences']" 2>/dev/null | grep -q button-layout && break; sleep 1; done; sleep 2
gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.portal.Settings.Read org.gnome.desktop.wm.preferences button-layout 2>&1 | head -1
(WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gnome-text-editor >$W/app.log 2>&1 &)
for _ in $(seq 1 90); do P 'return global.get_window_actors().filter(a=>a.meta_window.get_wm_class()==="org.gnome.TextEditor").length' | grep -qE "\('?[1-9]" && break; sleep 1; done; sleep 2
P "return global.get_window_actors().map(a=>a.meta_window.get_title()+' '+a.meta_window.get_wm_class())"
P "const ind=[];const w=a=>{ if((a.style_class||'').includes('window-controls')||(a.style_class||'').includes('guava-window-controls')) ind.push(a.constructor.name+' vis='+a.visible+' mapped='+a.mapped+' '+(a.style_class)); a.get_children().forEach(w)}; w(Main.panel); return ind"
echo "== notification"
P "globalThis.__n=0; const s=Main.messageTray; s.connect('source-added',()=>globalThis.__n++); return 'hooked'"
notify-send -a x2test "Hello" "body text" 2>&1; sleep 2
gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.Notify x2 0 "" "Sum" "Body" "[]" "{}" 4000 2>&1
sleep 2
P "return {sources:Main.messageTray.getSources().length, banner:Main.messageTray._banner?.constructor?.name ?? null, bannerVisible:Main.messageTray._bannerBin?.visible, notchState: (()=>{const o=[];const w=a=>{ if(a.name==='guava-notch') o.push({vis:a.visible,w:a.width,h:a.height,kids:a.get_n_children()}); a.get_children().forEach(w)}; w(global.stage); return o})()}"

echo "== FUNCTIONAL PROBES"
T overview-hidden "$SL"'Main.overview.hide(); await sl(1200); return Main.overview.visible ? "FAIL overview still visible" : "PASS overview hidden"'
T notch-receives-notification "$SL"'
const n=()=>{let o=null;const w=a=>{ if(a.name==="guava-notch") o=a; a.get_children().forEach(w)}; w(global.stage); return o};
Main.messageTray.getSources().forEach(s=>{try{s.destroy()}catch(e){}});
await sl(300);
const p=Gio.Subprocess.new(["notify-send","-a","x2probe","Probe title","probe body"],0); await sl(1800);
const nt=n(); const ban=Main.messageTray._banner; const bannerShown=!!ban && ban.visible && Main.messageTray._bannerBin?.visible;
const notchShown=!!nt && nt.visible && nt.get_n_children()>0;
return (notchShown && !bannerShown ? "PASS" : "FAIL")+` notchShown=${notchShown} stockBannerShown=${bannerShown} notchKids=${nt?.get_n_children()}`'
await_s() { :; }
T spotlight-open-close "$SL"'
const s=inst("spotlight"); if(!s) return "FAIL no spotlight instance";
s.toggle(); await sl(1000); const o=s._modal.isOpen; s.toggle(); await sl(1200); const c=!s._modal.isOpen;
return (o&&c?"PASS":"FAIL")+` opened=${o} closedAfter=${c}`'
T quick-settings-columns "$SL"'
const qs=Main.panel.statusArea.quickSettings; qs.menu.open(); await sl(1000);
const g=qs.menu._grid; const lm=g?.layout_manager; const cols=lm?.n_columns; const kids=g?.get_n_children();
qs.menu.close(); await sl(500);
return (cols>0?"PASS":"FAIL")+` n_columns=${cols} gridChildren=${kids} width=${Math.round(g?.width)}`'
T maximize-workarea "$SL"'
const wa=global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()==="org.gnome.TextEditor"); if(!wa) return "FAIL no editor window";
const area=wa.get_work_area_current_monitor();
if (wa.maximize.length===0 && Meta.MaximizeFlags===undefined) wa.maximize(); else { try { wa.maximize(Meta.MaximizeFlags.BOTH) } catch(e) { wa.maximize() } }
await sl(1200); const r=wa.get_frame_rect(); const maxed=wa.is_maximized ? wa.is_maximized() : (wa.maximized_horizontally&&wa.maximized_vertically);
const ind=Main.panel.statusArea?.["guava-window-controls"] ?? null;
const ctrl=(()=>{let o=[];const w=a=>{ if((a.constructor.name==="WindowControlsIndicator")) o.push(a.visible); a.get_children().forEach(w)}; w(Main.panel); return o})();
wa.unmaximize ? (()=>{try{wa.unmaximize(Meta.MaximizeFlags.BOTH)}catch(e){wa.unmaximize()}})() : 0; await sl(800);
const r2=wa.get_frame_rect();
return (maxed&&r.y>=area.y&&r.height<=area.height&&r.y+r.height<=area.y+area.height+1?"PASS":"FAIL")+` maxed=${maxed} workarea=${area.x},${area.y} ${area.width}x${area.height} maxRect=${r.x},${r.y} ${r.width}x${r.height} afterUnmax=${r2.width}x${r2.height} controlsIndicatorVisibleWhileMax=${JSON.stringify(ctrl)}`'
(WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gjs $W/x2app.js >$W/app2.log 2>&1 9>&- &)
for _ in $(seq 1 40); do P 'return global.get_window_actors().filter(a=>a.meta_window.get_wm_class()==="org.x2.TestB").length' | grep -qE "\('?[1-9]" && break; sleep 1; done; sleep 2
T stage-manager-hide-reveal "$SL"'
const sm=inst("stage-manager"); if(!sm) return "FAIL no stage-manager instance (status="+reg.status("stage-manager")+")";
const wins=()=>global.get_window_actors().filter(a=>a.meta_window.get_window_type()===Meta.WindowType.NORMAL);
const snap=()=>wins().map(a=>a.meta_window.get_wm_class()+":op"+a.opacity+":vis"+a.visible+":min"+a.meta_window.minimized);
await sl(1000); const before=snap(); const hidden=wins().filter(a=>a.opacity===0);
if (wins().length<2) return "FAIL need 2 windows, have "+JSON.stringify(before);
if (hidden.length===0) return "FAIL none hidden (opacity 0) "+JSON.stringify(before);
const target=hidden[0].meta_window; target.activate(global.get_current_time()); await sl(1800);
const after=snap(); const rev=wins().find(a=>a.meta_window===target);
return (rev.opacity>0?"PASS":"FAIL")+` before=${JSON.stringify(before)} after=${JSON.stringify(after)}`'
T no-topbar-window-controls "$SL"'
let ind=null;const w=a=>{ if(a.has_style_class_name?.("guava-window-controls-indicator")||a.has_style_class_name?.("window-controls-box")||a.has_style_class_name?.("window-control-button")) ind=a; a.get_children().forEach(w)}; w(Main.panel);
const bl=new Gio.Settings({schema_id:"org.gnome.desktop.wm.preferences"}).get_string("button-layout");
const side=new Gio.Settings({schema_id:"org.gnome.shell.extensions.guava-os"}).get_string("window-controls-side");
const wants=side==="right"?/:.*close/.test(bl):/close.*:/.test(bl);
return (!ind && wants ?"PASS":"FAIL")+` noIndicator=${!ind} side=${side} wmLayout=${bl}`'
T clipboard-history-increments "$SL"'
const c=inst("clipboard-history"); if(!c) return "FAIL no clipboard instance";
const b=c.count; const txt="x2-probe-"+Date.now();
St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, txt); await sl(2500);
const a=c.count; const latest=c.latest?.(1);
return (a>b?"PASS":"FAIL")+` before=${b} after=${a} recording=${c.recording} latest=${JSON.stringify(latest)?.slice(0,120)}`'
# Optional per-agent probes/screenshots (GUAVA_EXTRA). P, T, SL, gs are available; shots go to /opt/shots.
SHOT() { P "const f=Gio.File.new_for_path('/opt/shots/$1.png'); const s=f.replace(null,false,0,null); const sh=new Shell.Screenshot(); await new Promise((res,rej)=>sh.screenshot(false,s,(o,r)=>{try{o.screenshot_finish(r);res()}catch(e){rej(e)}})); s.close(null); return 'shot $1'"; }
if [ -f /opt/guava-extra.sh ]; then echo "== EXTRA"; . /opt/guava-extra.sh; fi
echo "== settings flipping"
for k in notch liquid-glass control-center stage-manager clipboard-history spotlight; do for v in false true; do gs $k $v; sleep 0.7; done; done
P "const f=Main.extensionManager.lookup('guava-os@blueyzx64').stateObj._features; const o={}; for (const id of f._status.keys()) o[id]=f.status(id); return o"
echo "== toggling $N x"
D="gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions"
for _ in $(seq 1 $N); do $D.DisableExtension $UUID >/dev/null 2>&1; sleep 1; $D.EnableExtension $UUID >/dev/null 2>&1; sleep 2; done
P "const e=Main.extensionManager.lookup('guava-os@blueyzx64'); const f=e.stateObj?._features; return [e.state, f? [...f._status.keys()].filter(i=>f.status(i)!=='off'):null]"
P "return Main.panel._rightBox.get_n_children()"
P "imports.system.gc(); return 1"; sleep 1; P "imports.system.gc(); return 1"; kill $SP; sleep 2
IN
export W X UUID N
timeout 400 dbus-run-session -- bash $W/session.sh 2>&1
echo "== SHELL LOG ANALYSIS"
L=$W/shell.log
echo "lines: $(wc -l <$L)"; head -3 $L
cp $L /opt/shell.log
grep -E "guava-os@blueyzx64|\[Guava\]" $L | sed -E 's/^[0-9:.]+ *//' | sed -E 's/0x[0-9a-f]+/N/g' | sort | uniq -c | sort -rn | head -60
echo "-- CRITICAL/JS ERROR (all)"
grep -E "CRITICAL|JS ERROR|Gjs-WARNING|WARNING \*\*" $L | sed -E 's/^[0-9:.]+ *//;s/0x[0-9a-f]+/N/g' | cut -c1-200 | sort | uniq -c | sort -rn | head -40
