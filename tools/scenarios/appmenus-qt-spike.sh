# Spike: does a Qt6 widgets app on native Wayland call the AppMenu Registrar, with which id?
# Setup: designer-qt6 (Qt Designer, has a menu bar) is already in the f44 root (qt6-designer).
WL=$(ls "$W/run" 2>/dev/null | grep -m1 '^wayland-[0-9]*$')
echo "SPIKE registrar owner: $(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetNameOwner com.canonical.AppMenu.Registrar 2>&1)"
for th in none gnome gtk3 xdgdesktopportal; do
  dbus-monitor --session "interface='com.canonical.AppMenu.Registrar'" >"$W/mon-$th.log" 2>&1 &
  MON=$!
  (cd "$W/home" && env HOME="$HOME" WAYLAND_DISPLAY="$WL" XDG_RUNTIME_DIR="$W/run" QT_QPA_PLATFORM=wayland QT_QPA_PLATFORMTHEME=$th QT_LOGGING_RULES='qt.qpa.*=true;qt.dbus*=true' designer-qt6 >"$W/app-qt-$th.log" 2>&1 9>&- &)
  sleep 8
  echo "SPIKE theme=$th monitor: $(grep -c RegisterWindow "$W/mon-$th.log") RegisterWindow calls"
  grep -A3 "RegisterWindow" "$W/mon-$th.log" | head -6
  grep -i "theme\|menubar\|registrar\|AppMenu" "$W/app-qt-$th.log" | head -5
  kill $MON
  P "global.get_window_actors().map(a=>a.meta_window).filter(w=>/designer/i.test(w.get_wm_class()??'')).forEach(w=>w.kill()); return 1" >/dev/null; sleep 2
done
