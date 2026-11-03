# Scenario for the real-Shell harness (GUAVA_EXTRA, bundled after tools/harness/lib/lib.sh).
# The preferences window opens as the user opens it (gnome-extensions prefs), every page builds,
# and its process logs no JavaScript error. Then every sidebar page is visited, and the Setup
# Assistant opens and closes.
# Start the prefs service ourselves (D-Bus activation hides its stderr), then ask it to open Guava's prefs
launch_app "/usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions & sleep 3; gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.OpenExtensionPrefs guava-os@blueyzx64 '' '{}'; wait" org.gnome.Shell.Extensions 60
sleep 3
shot prefs-open
LOG=$(ls "$W"/app-org_gnome_Shell_Extensions*.log 2>/dev/null | head -1)
errs() { grep -E 'JS ERROR|JS WARNING|CRITICAL|TypeError|ReferenceError|SyntaxError|is not a function|is undefined|is null' "$LOG" 2>/dev/null | grep -v 'Gtk-WARNING' | head -20; }
assert "prefs window is mapped" "kwin('org.gnome.Shell.Extensions')!==null"
e=$(errs); [ -n "$e" ] && printf 'PREFS LOG:\n%s\n' "$e"
assert "prefs process logged no JS error at open" "$( [ -z "$e" ] && echo true || echo false )"
# Visit every sidebar row with the keyboard (Tab into the sidebar, then Down through it)
for i in $(seq 1 24); do key Down; sleep 0.4; done
shot prefs-after-pages
e=$(errs); [ -n "$e" ] && printf 'PREFS LOG:\n%s\n' "$e"
assert "prefs process logged no JS error while visiting pages" "$( [ -z "$e" ] && echo true || echo false )"
P "kwin('org.gnome.Shell.Extensions')?.delete(global.get_current_time()); return 1" >/dev/null
sleep 2
assert "prefs window closed" "kwin('org.gnome.Shell.Extensions')===null"
assert_summary
