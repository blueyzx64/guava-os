# Scenario for the real-Shell harness (GUAVA_EXTRA; bundle with tools/harness/lib/lib.sh first).
# core/debugLog.js: with debug-logging on, Guava writes a "[Guava debug]" timeline for bug reports
# (tools/guava-logs.sh); off, it writes nothing. Window titles never appear in it.
force_animations on
gs stage-manager false
sleep 1
# The harness Shell logs to $W/shell.log (a real session: the journal). No backslash escapes in the
# JS below: gdbus turns \n into a real line break
H='const L=()=>{const [ok,b]=GLib.file_get_contents("/tmp/w/shell.log");return new TextDecoder().decode(b).split(String.fromCharCode(10)).filter(l=>l.includes("[Guava debug]"))};
const W=()=>global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()==="org.gnome.TextEditor")??null;
const sl2=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return false}));
globalThis.L=L;'
J() { _kjs "$H $1"; }
J "return 1" >/dev/null
assert "debug-off-writes-nothing" "(()=>{const [ok,b]=GLib.file_get_contents('/tmp/w/shell.log');return !new TextDecoder().decode(b).includes('[Guava debug]')})()"
gs debug-logging true
sleep 2
gs dock-magnification true
sleep 0.5
gs dock-magnification false
J "const w=W(); globalThis.__title=w?.get_title()??''; Main.overview.show(); await sl2(1500); Main.overview.hide(); await sl2(1500); w.minimize(); await sl2(1200); w.unminimize(); await sl2(1200); const t=GLib.get_monotonic_time(); while(GLib.get_monotonic_time()-t<300000); await sl2(400); return 1" >/dev/null
J "return 'debug lines '+L().length+String.fromCharCode(10)+L().slice(0,40).map(l=>l.replace(/^.*\[Guava debug\]/,'')).join(String.fromCharCode(10))"
assert "debug-start-line"      "L().some(l=>/start: debug log on \{shell:/.test(l))"
assert "debug-monitors"        "L().some(l=>/shell: monitors /.test(l))"
assert "debug-overview-timed"  "L().some(l=>/shell: overview shown \{ms:/.test(l)) && L().some(l=>/shell: overview hidden \{ms:/.test(l))"
assert "debug-effects"         "L().some(l=>/shell: effect minimize /.test(l)) && L().some(l=>/shell: effect unminimize /.test(l))"
assert "debug-feature-line"    "L().some(l=>/minimize-effect: minimize \{mode:\"genie\"/.test(l))"
assert "debug-events-tap"      "L().some(l=>/events: window-changed /.test(l))"
assert "debug-loop-stall"      "L().some(l=>/loop: main loop stall \{ms:([2-9][0-9]{2}|1[0-9]{2})/.test(l))"
assert "debug-settings-change" "L().some(l=>/settings: dock-magnification true/.test(l))"
assert "debug-no-window-title" "globalThis.__title.length>0 && !L().some(l=>l.includes(globalThis.__title))"
gs debug-logging false
sleep 1
J "globalThis.__n=L().length; Main.overview.show(); await sl2(1200); Main.overview.hide(); await sl2(1200); return 1" >/dev/null
assert "debug-off-again-stops" "L().length===globalThis.__n && L().some(l=>/debug log off/.test(l))"
assert_summary
