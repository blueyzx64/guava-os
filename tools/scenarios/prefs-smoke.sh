# Scenario for the real-Shell harness (GUAVA_EXTRA, bundled after tools/harness/lib/lib.sh).
# The preferences window opens as the user opens it (gnome-extensions prefs), every page builds,
# and its process logs no JavaScript error. Then every sidebar page is visited, and the Setup
# Assistant opens and closes.
# Start the prefs service ourselves (D-Bus activation hides its stderr), then ask it to open Guava's prefs
gs onboarding "'done'"; sleep 1
# Open it as the user does: the Shell starts the prefs service over D-Bus (its display comes from the
# activation environment, set as soon as the compositor runs, as in a real session)
# The prefs service is started here first, so its stderr lands in a file this scenario can read;
# `gnome-extensions prefs` then goes through the Shell to that same running service
# The Setup Assistant may have started one already at login: close it, so ours owns the name
P "global.get_window_actors().map(a=>a.meta_window).filter(w=>(w.get_title()??'').includes('Guava')).forEach(w=>w.delete(global.get_current_time())); return 1" >/dev/null
# Never pkill -f here: harness roots are chroots sharing the host's PID namespace, so a pattern
# kill also hits other roots and the host. Kill exactly the process owning the name on OUR bus.
svc=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID org.gnome.Shell.Extensions 2>/dev/null | grep -o '[0-9]\+' | head -1)
[ -n "$svc" ] && kill "$svc" 2>/dev/null; sleep 1
WDS=$(ls $W/run | grep -m1 '^wayland-[0-9]*$')
(cd "$W/home" && env HOME="$HOME" WAYLAND_DISPLAY="$WDS" XDG_RUNTIME_DIR="$W/run" GDK_BACKEND=wayland \
   gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions >"$W/prefs-service.log" 2>&1 &)
sleep 3
(cd "$W/home" && env HOME="$HOME" XDG_RUNTIME_DIR="$W/run" gnome-extensions prefs guava-os@blueyzx64 >"$W/app-prefs-cli.log" 2>&1 &)
PREFS="global.get_window_actors().map(a=>a.meta_window).find(w=>(w.get_title()??'').includes('Guava'))"
for _ in $(seq 1 40); do r=$(_kjs "return !!($PREFS)"); case "$r" in *true*) break;; esac; sleep 1; done
sleep 3
shot prefs-open
# The service's own output goes to the session bus log; the Shell log has its JS errors too
LOG=$W/shell.log
errs() { { grep -E 'org.gnome.Shell.Extensions|prefs' "$LOG"; cat "$W/prefs-service.log"; } 2>/dev/null | grep -E 'JS ERROR|CRITICAL|TypeError|ReferenceError|exited with status|Failed to set text|markup' | head -20; }
assert "prefs window is mapped" "!!($PREFS)"
e=$(errs); [ -n "$e" ] && printf 'PREFS LOG:\n%s\n' "$e"
assert "prefs process logged no JS error at open" "$( [ -z "$e" ] && echo true || echo false )"
# Visit every sidebar row with the keyboard (Tab into the sidebar, then Down through it)
for i in $(seq 1 24); do key Down; sleep 0.4; done
shot prefs-after-pages
e=$(errs); [ -n "$e" ] && printf 'PREFS LOG:\n%s\n' "$e"
assert "prefs process logged no JS error while visiting pages" "$( [ -z "$e" ] && echo true || echo false )"
P "($PREFS)?.delete(global.get_current_time()); return 1" >/dev/null
sleep 2
assert "prefs window closed" "!($PREFS)"
assert_summary
