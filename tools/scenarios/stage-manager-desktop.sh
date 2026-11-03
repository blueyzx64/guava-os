# Stage Manager: Option-click opens into the current stage (RV1-1, SM-29) and Show Desktop falls back
# when the stage holds no managed window (RV1-2, SM-31). Bundle after stage-manager-lib.sh.
echo "-- SM desktop and open into stage"
force_animations on
# Desktop entries for the test apps: the dock and the app grid list them by id
mkdir -p $W/home/.local/share/applications
for x in A B C; do
  cat > $W/home/.local/share/applications/org.x2.Sm$x.desktop <<EOF2
[Desktop Entry]
Type=Application
Name=SM $x
Exec=gjs $W/smapp.js org.x2.Sm$x
StartupWMClass=org.x2.Sm$x
EOF2
done
sleep 1
sm_up A B C
sm_state
assert "pre: C is the stage, A and B in the strip" "onStage(sid('C')) && inStrip(sid('A')) && inStrip(sid('B'))"
assert "pre: the dock lists A and B" "!!inst('dock')._view.item('org.x2.SmA.desktop') && !!inst('dock')._view.item('org.x2.SmB.desktop')"

echo "-- RV1-1 Option-click on a Dock icon: A joins the stage, B stays in the strip"
_kjs 'const d=inst("dock"); const r=d.rectOf(d._view.item("org.x2.SmA.desktop")); kvk.notify_keyval(kus(),Clutter.KEY_Alt_L,Clutter.KeyState.PRESSED); await sl(120); await kclick(Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)); kvk.notify_keyval(kus(),Clutter.KEY_Alt_L,Clutter.KeyState.RELEASED); await sl(1800); return 1' >/dev/null
sm_state
assert "RV1-1 A and C are both on the stage" "wst(sid('A')).op===255 && wst(sid('C')).op===255"
assert "RV1-1 B waits in the strip" "inStrip(sid('B'))"

echo "-- a plain click on B's icon swaps the stage as before"
_kjs 'const d=inst("dock"); const r=d.rectOf(d._view.item("org.x2.SmB.desktop")); await kclick(Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)); await sl(1800); return 1' >/dev/null
sm_state
assert "plain click: only B on the stage" "onStage(sid('B')) && inStrip(sid('A')) && inStrip(sid('C'))"

echo "-- RV1-1 Option-click on a Launchpad tile"
_kjs 'const lp=inst("launchpad"); lp.open(); await sl(1500); kvk.notify_keyval(kus(),Clutter.KEY_Alt_L,Clutter.KeyState.PRESSED); await sl(120); await kmove(300,300); const dbg="jig="+lp.view.jiggling+" app="+!!lp.view.store.app("org.x2.SmA.desktop")+" host="+(lp.view.host===lp); try { lp.view.activate({kind:"app",id:"org.x2.SmA.desktop"}); } catch (e) { return "LPERR "+e.message+e.stack } finally { kvk.notify_keyval(kus(),Clutter.KEY_Alt_L,Clutter.KeyState.RELEASED); } const t0=lp.view; await sl(1800); return "LPOK "+dbg+" view_after_activate="+!!t0+" now="+!!lp.view+" ptr="+JSON.stringify(global.get_pointer())' | grep -o 'LP[A-Z]*.*' | head -3
sm_state
assert "RV1-1 launchpad: A and its set mate C joined B on the stage" "wst(sid('A')).op===255 && wst(sid('B')).op===255 && wst(sid('C')).op===255"
wait_for "!inst('launchpad').view" 5 >/dev/null
assert "RV1-1 launchpad closed" "!inst('launchpad').view"

echo "-- SM-31 Show Desktop with a managed stage: Stage Manager handles it"
_kjs 'inst("show-desktop").toggle(); await sl(1500); return 1' >/dev/null
assert "SM-31 stage hidden by Stage Manager, Show Desktop's own reveal not used" "inst('stage-manager').isDesktopShown && !inst('show-desktop').shown"
_kjs 'inst("show-desktop").toggle(); await sl(1500); return 1' >/dev/null
assert "SM-31 stage back" "!inst('stage-manager').isDesktopShown && wst(sid('A')).op===255 && wst(sid('B')).op===255"
sm_down

echo "-- RV1-2 Show Desktop when no window is managed (all windows set aside, as split view does)"
WS_URL=file:///tmp/w/home/.local/share/gnome-shell/extensions/guava-os@blueyzx64/core/windowState.js
J='const {WindowState}=await import("'$WS_URL'"); for (const a of global.get_window_actors()) WindowState.set(a.meta_window,"splitView",true); await sl(1000); return 1'
_kjs "$J" >/dev/null
assert "pre: Stage Manager has no stage window" "inst('stage-manager')._model.stageWindows().length===0"
_kjs 'inst("show-desktop").toggle(); await sl(1500); return 1' >/dev/null
assert "RV1-2 Show Desktop revealed the desktop itself" "inst('show-desktop').shown && global.get_window_actors().some(a=>a.meta_window.get_window_type()===Meta.WindowType.NORMAL && (a.translation_x!==0||a.translation_y!==0))"
_kjs 'inst("show-desktop").toggle(); await sl(1500); return 1' >/dev/null
assert "RV1-2 the second toggle brings them back" "!inst('show-desktop').shown && global.get_window_actors().every(a=>a.translation_x===0&&a.translation_y===0)"
_kjs 'const {WindowState}=await import("'$WS_URL'"); for (const a of global.get_window_actors()) WindowState.set(a.meta_window,"splitView",false); return 1' >/dev/null
rm -f $W/home/.local/share/applications/org.x2.Sm?.desktop
assert_summary
