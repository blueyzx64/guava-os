#!/bin/bash
# Headless smoke test: start gnome-shell in a throwaway profile, enable Guava,
# toggle it N times, then summarise Guava-related errors. Exit 1 if any.
# Usage: tools/smoke/run-headless.sh [toggles]      (default 10)
# Env:   GUAVA_SMOKE_SHELL_VERSION=46  add this version to the TEMP copy's metadata.json
#        GUAVA_SMOKE_SHIM=1            container-only Shell-46 API shims (temp copy only)
#        GUAVA_SMOKE_KEEP=1            keep the work dir; GUAVA_SMOKE_DIR=path to choose it
set -u
SRC=$(cd "$(dirname "$0")/../.." && pwd)
N=${1:-10}
W=${GUAVA_SMOKE_DIR:-$(mktemp -d /tmp/guava-smoke.XXXXXX)}
UUID=guava-os@blueyzx64
for c in gnome-shell dbus-run-session gsettings glib-compile-schemas gdbus tar; do
  command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 2; }
done
mkdir -p "$W/home/.config" "$W/home/.cache" "$W/run"; chmod 700 "$W/run"
E=$W/home/.local/share/gnome-shell/extensions/$UUID
rm -rf "$E"; mkdir -p "$E"
(cd "$SRC" && tar --exclude=.git --exclude=docs --exclude=tests --exclude=po --exclude=tools -cf - .) | tar -xf - -C "$E"
if [ -n "${GUAVA_SMOKE_SHELL_VERSION:-}" ]; then
  sed -i "s/\"shell-version\": \[/\"shell-version\": [\"$GUAVA_SMOKE_SHELL_VERSION\",/" "$E/metadata.json"
fi
if [ "${GUAVA_SMOKE_SHIM:-0}" = 1 ]; then
  sed -i 's/extends MessageList.MessageView {/extends (MessageList.MessageView ?? St.BoxLayout) {/' "$E/features/calendar/notificationList.js"
  grep -rl 'orientation: Clutter.Orientation' "$E" --include=*.js | xargs -r sed -i \
    's/orientation: Clutter.Orientation.VERTICAL/vertical: true/;s/orientation: Clutter.Orientation.HORIZONTAL/vertical: false/'
fi
glib-compile-schemas "$E/schemas" || exit 2

# Fake logind only when the system bus lacks login1 (containers).
FAKE=
if ! gdbus call --system --dest org.freedesktop.login1 --object-path /org/freedesktop/login1 \
     --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; then
  command -v gjs >/dev/null || { echo "no login1 and no gjs for fake-logind" >&2; exit 2; }
  [ -S /run/dbus/system_bus_socket ] || { mkdir -p /run/dbus; dbus-daemon --system --fork; }
  gjs "$SRC/tools/smoke/fake-logind.js" >"$W/fake-logind.log" 2>&1 & FAKE=$!
  sleep 1
fi

cat >"$W/inner.sh" <<'IN'
# Temp profile only: keyfile backend never touches the real dconf.
export HOME=$W/home XDG_CONFIG_HOME=$W/home/.config XDG_DATA_HOME=$W/home/.local/share
export XDG_CACHE_HOME=$W/home/.cache XDG_RUNTIME_DIR=$W/run GSETTINGS_BACKEND=keyfile
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 >"$W/shell.log" 2>&1 &
SP=$!
sleep 12
D="gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions"
$D.ListExtensions >"$W/list.txt" 2>&1
for _ in $(seq 1 "$N"); do $D.DisableExtension "$UUID" >/dev/null 2>&1; sleep 1; $D.EnableExtension "$UUID" >/dev/null 2>&1; sleep 2; done
kill "$SP"; sleep 2
IN
export W N UUID
timeout $((60 + N * 5)) dbus-run-session -- bash "$W/inner.sh" >"$W/session.log" 2>&1
[ -n "$FAKE" ] && kill "$FAKE" 2>/dev/null

L=$W/shell.log
echo "== Guava smoke: $N toggles; shell: $(gnome-shell --version); log: $L"
grep -q "GNOME Shell started" "$L" || { echo "Shell did not start; see $L and $W/session.log"; exit 2; }
grep -q "$UUID" "$W/list.txt" || echo "WARN: $UUID not listed by the Shell (version unsupported? set GUAVA_SMOKE_SHELL_VERSION)"
# Guava-related: lines naming the extension dir, [Guava], or a CRITICAL/ERROR with a Guava stack frame.
python3 - "$L" "$UUID" <<'PY'
import re, sys, collections
log, uuid = open(sys.argv[1], errors="replace").read().split("\n"), sys.argv[2]
hdr = re.compile(r"(CRITICAL|JS ERROR)")
frame = re.compile(r"extensions/" + re.escape(uuid) + r"/([^:\s]+:\d+)")
groups = collections.Counter(); msgs = {}
crit = js = 0
i = 0
while i < len(log):
    l = log[i]
    if hdr.search(l):
        blk = [l]; j = i + 1
        while j < len(log) and log[j].strip() and not hdr.search(log[j]) and not log[j].startswith("("):
            blk.append(log[j]); j += 1
        txt = "\n".join(blk)
        m = frame.search(txt)
        if m or "[Guava]" in txt:
            key = m.group(1) if m else "(no frame)"
            msg = re.sub(r"^.*?(CRITICAL|JS ERROR)[^:]*:\s*", "", l)[:110]
            msg = re.sub(r"^\d\d:\d\d:\d\d\.\d+:\s*", "", msg)
            msg = re.sub(r"0x[0-9a-f]+|\bid '?\d+'?|Source ID \d+", "N", msg)
            groups[(key, msg)] += 1
            if "JS ERROR" in l: js += 1
            else: crit += 1
        i = j
    else:
        i += 1
print(f"Guava JS errors: {js}   Guava CRITICALs: {crit}")
for (k, m), c in groups.most_common():
    print(f"  {c:4d}x {k}  {m}")
sys.exit(1 if groups else 0)
PY
rc=$?
[ "${GUAVA_SMOKE_KEEP:-0}" = 1 ] || [ -n "${GUAVA_SMOKE_DIR:-}" ] || { [ $rc -eq 0 ] && rm -rf "$W"; }
exit $rc
