# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh).
# How long the preferences window takes to appear, as the Shell opens it (the OpenExtensionPrefs call of
# features/onboarding at the first login, `gnome-extensions prefs` later): cold (the prefs service not
# running yet) and warm (service already up). The window must be on screen within 1 s of the call's reply on
# llvmpipe, and the call itself must come back at once (it timed out after 25 s at the first login).
gs onboarding "'done'"; sleep 1
PREFS="global.get_window_actors().map(a=>a.meta_window).find(w=>(w.get_title()??'').includes('Guava'))"
closeprefs() { P "global.get_window_actors().map(a=>a.meta_window).filter(w=>(w.get_title()??'').includes('Guava')).forEach(w=>w.delete(global.get_current_time())); return 1" >/dev/null; sleep 2; }
now() { date +%s.%N; }
open_timed() {
  local label=$1 t0 t1 t2 r
  t0=$(now)
  timeout 40 gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.OpenExtensionPrefs guava-os@blueyzx64 '' '{}' >"$W/prefs-call-$label.log" 2>&1
  t1=$(now)
  for _ in $(seq 1 600); do r=$(_kjs "return !!($PREFS)"); case "$r" in *true*) break;; esac; sleep 0.1; done
  t2=$(now)
  REPLY_S=$(awk "BEGIN{print $t1-$t0}"); WIN_S=$(awk "BEGIN{print $t2-$t0}"); AFTER_S=$(awk "BEGIN{print $t2-$t1}")
  printf 'PREFSTIME %s: call returned after %.2fs, window mapped %.2fs after the call, %.2fs after the reply\n' "$label" "$REPLY_S" "$WIN_S" "$AFTER_S"
  cat "$W/prefs-call-$label.log" | head -3
}
# The service may be running from the first-login offer: end it (exactly the process owning the name on OUR bus)
closeprefs
svc=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID org.gnome.Shell.Extensions 2>/dev/null | grep -o '[0-9]\+' | tail -1)
echo "PREFSTIME service pid before the cold call: ${svc:-none}"; [ -n "$svc" ] && kill "$svc" 2>/dev/null; sleep 2
open_timed cold
COLD_REPLY=$REPLY_S; COLD_AFTER=$AFTER_S
sleep 3
closeprefs
open_timed warm
WARM_REPLY=$REPLY_S; WARM_AFTER=$AFTER_S
lt() { awk "BEGIN{print ($1 < $2) ? \"true\" : \"false\"}"; }
assert "prefs window opened" "!!($PREFS)"
assert "cold: the call returns within 5 s" "$(lt "$COLD_REPLY" 5)"
assert "cold: the window is mapped within 1 s of the reply" "$(lt "$COLD_AFTER" 1)"
assert "warm: the call returns within 1 s" "$(lt "$WARM_REPLY" 1)"
assert "warm: the window is mapped within 1 s of the reply" "$(lt "$WARM_AFTER" 1)"
closeprefs
assert_summary
