# harness-env: GUAVA_X11=1
# Scenario for the real-Shell harness (GUAVA_EXTRA, bundled after tools/harness/lib/lib.sh).
# A real X11 client (xterm under Xwayland, server-side decorations drawn by Mutter) goes through
# Guava's window features: minimize (and back), maximize, tiling, full screen in its own Space,
# the menu bar's app name, and close. Earlier "X11" runs used Wayland test apps only.
D=$(_kjs "return GLib.getenv('DISPLAY') ?? ''" | grep -o ':[0-9]*' | head -1)
# Mutter protects Xwayland with an X authority file and hands it to apps as XAUTHORITY
XA=$(_kjs "return GLib.getenv('XAUTHORITY') ?? ''" | sed -n "s/^('\"\(.*\)\"',)$/\1/p")
echo "X11 DISPLAY=$D XAUTHORITY=$XA"
launch_app "env DISPLAY=$D XAUTHORITY=$XA xterm -geometry 80x24+120+120" XTerm 60
W1="global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_wm_class()==='XTerm')"
assert "xterm is an X11 client" "($W1)?.get_client_type()===Meta.WindowClientType.X11"
P "($W1).activate(global.get_current_time()); return 1" >/dev/null; sleep 1.5
APPNAME="(inst('menu-bar')?.part('apps')?._buttons ?? []).map(b=>b._label?.text ?? '').join('|')"
echo "MENUBAR titles: $(_kjs "return $APPNAME")"
assert "menu bar names the X11 app" "/xterm/i.test($APPNAME)"
P "($W1).minimize(); return 1" >/dev/null; sleep 2
assert "X11 window minimizes" "($W1).minimized === true"
P "($W1).unminimize(); ($W1).activate(global.get_current_time()); return 1" >/dev/null; sleep 2
assert "X11 window restores" "($W1).minimized === false && ($W1).get_compositor_private().visible"
P "($W1).maximize(); return 1" >/dev/null; sleep 2
assert "X11 window maximizes (Shell request, not the green button)" "($W1).is_maximized() || ($W1).is_fullscreen()"
P "if (($W1).is_fullscreen()) ($W1).unmake_fullscreen(); if (($W1).is_maximized()) ($W1).unmaximize(); return 1" >/dev/null; sleep 2
echo "TILE before: $(_kjs "const r=($W1).get_frame_rect(); const a=($W1).get_work_area_current_monitor(); return [r.x,r.y,r.width,r.height,'area',a.x,a.y,a.width,a.height,'max',($W1).is_maximized()].join(' ')")"
echo "TILE call: $(_kjs "inst('window-tiling').tile(($W1), 'left'); return 'ok'")"; sleep 2
echo "TILE after: $(_kjs "const r=($W1).get_frame_rect(); return [r.x,r.y,r.width,r.height,'tiled',inst('window-tiling')?.isTiled?.(($W1))].join(' ')")"
assert "X11 window tiles to the left half" "(()=>{const w=($W1);const r=w.get_frame_rect();const a=w.get_work_area_current_monitor();return r.x<=a.x+40 && r.width<a.width*0.6 && r.width>a.width*0.4;})()"
_kjs "inst('window-tiling').restore(($W1)); return 1" >/dev/null; sleep 1.5
ws0=$(_kjs "return ($W1).get_workspace().index()" | grep -o '[0-9]\+' | head -1)
P "($W1).make_fullscreen(); return 1" >/dev/null; sleep 4
assert "X11 window goes full screen" "($W1).is_fullscreen()"
shot x11-fullscreen
P "($W1).unmake_fullscreen(); return 1" >/dev/null; sleep 4
assert "X11 window leaves full screen" "!($W1).is_fullscreen()"
P "($W1).delete(global.get_current_time()); return 1" >/dev/null; sleep 2
assert "X11 window closed" "!($W1)"
assert_summary
