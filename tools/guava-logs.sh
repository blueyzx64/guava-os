#!/usr/bin/env bash
# guava-logs.sh: record what Guava does while you reproduce a problem, and pack it for a bug report.
#
#   tools/guava-logs.sh                 record (the same as `record`)
#   tools/guava-logs.sh record [label]  turn the debug log on, record until you type q, pack it
#   tools/guava-logs.sh snapshot        no recording: this boot's Shell log and your setup, packed
#   tools/guava-logs.sh on | off        leave the debug log on (or off) for a long session; use
#                                       `snapshot` afterwards to collect it
#
# While recording, type a short note and press Enter to mark a step ("opened Mission Control",
# "Genie was skipped here"); the mark lands in the timeline at that moment. Type q and Enter (or
# press Ctrl+C) to stop. The result is ~/guava-logs/<date>-<label>.tar.gz: send that file.
#
# What is collected: the GNOME Shell and preferences log lines (the journal), Guava's debug
# timeline ("[Guava debug]" lines: events, window effects, the overview, slow frames, main-loop
# stalls, feature start times), your marks, the versions of GNOME, Mesa, the kernel and Guava, your
# GPU, monitors and scale, and Guava's settings. Guava's debug lines never contain window titles or
# other text; the Shell's own lines can (an app name in an error, for example). Everything is plain
# text in the folder next to the archive: read it before you send it if you like.
set -u

UUID=guava-os@blueyzx64
DCONF_DIR=/org/gnome/shell/extensions/guava-os/
KEY=debug-logging
OUT_ROOT=${GUAVA_LOGS_DIR:-$HOME/guava-logs}
# The Shell, the preferences window (a gjs process) and the marks this script writes
JOURNAL_MATCH=(_COMM=gnome-shell + _COMM=gjs + SYSLOG_IDENTIFIER=org.gnome.Shell.Extensions + SYSLOG_IDENTIFIER=guava-marker)

have() { command -v "$1" >/dev/null 2>&1; }
say() { printf '%s\n' "$*"; }
die() { printf 'guava-logs: %s\n' "$*" >&2; exit 1; }

have journalctl || die "journalctl not found (this script is for a systemd desktop such as Fedora)"

# ---- the debug-logging key ----------------------------------------------------------------------
# dconf needs no schema; gsettings needs the extension's schema directory
SCHEMADIR=""
for d in "$HOME/.local/share/gnome-shell/extensions/$UUID/schemas" "/usr/share/gnome-shell/extensions/$UUID/schemas"; do
    [ -f "$d/gschemas.compiled" ] && { SCHEMADIR=$d; break; }
done
debug_get() {
    if have dconf; then
        local v; v=$(dconf read "$DCONF_DIR$KEY" 2>/dev/null)
        [ "$v" = true ] && echo true || echo false
    elif [ -n "$SCHEMADIR" ]; then
        gsettings --schemadir "$SCHEMADIR" get org.gnome.shell.extensions.guava-os "$KEY" 2>/dev/null || echo false
    else
        echo false
    fi
}
debug_set() {
    if have dconf; then
        if [ "$1" = true ]; then dconf write "$DCONF_DIR$KEY" true; else dconf reset "$DCONF_DIR$KEY"; fi
    elif [ -n "$SCHEMADIR" ]; then
        gsettings --schemadir "$SCHEMADIR" set org.gnome.shell.extensions.guava-os "$KEY" "$1"
    else
        die "neither dconf nor Guava's installed schema was found: is Guava installed?"
    fi
}

mark() {
    # Into the journal (so it sits in the timeline) and into marks.txt
    local note=$1
    if have systemd-cat; then
        printf 'MARK %s\n' "$note" | systemd-cat -t guava-marker -p notice 2>/dev/null
    elif have logger; then
        logger -t guava-marker "MARK $note" 2>/dev/null
    fi
    printf '%s MARK %s\n' "$(date '+%F %T.%3N')" "$note" >> "$DIR/marks.txt"
}

# ---- what describes this machine ---------------------------------------------------------------
system_info() {
    {
        say "== collected $(date -Is) by tools/guava-logs.sh"
        say "== os";        grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release 2>/dev/null; uname -r
        say "== session";   say "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-?} XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-?}"
        say "== gnome";     gnome-shell --version 2>/dev/null
        say "== guava";     gnome-extensions info "$UUID" 2>/dev/null || say "(gnome-extensions info failed)"
        say "== enabled extensions"; gnome-extensions list --enabled 2>/dev/null
        say "== cpu / memory"; say "cpus: $(nproc 2>/dev/null)"; free -h 2>/dev/null | head -2
        say "== gpu"
        if have lspci; then lspci -nnk 2>/dev/null | grep -iA3 -E 'vga|3d controller|display controller'; fi
        if have glxinfo; then glxinfo -B 2>/dev/null | grep -E 'renderer|version|Video memory'; fi
        if have rpm; then rpm -q mesa-dri-drivers mesa-vulkan-drivers mutter gnome-shell gtk4 libadwaita 2>/dev/null; fi
        say "== monitors (Mutter DisplayConfig)"
        gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig \
            --method org.gnome.Mutter.DisplayConfig.GetCurrentState 2>/dev/null | head -c 6000; say
        say "== gnome settings that change Guava's behaviour"
        for k in "org.gnome.desktop.interface color-scheme" "org.gnome.desktop.interface enable-animations" \
                 "org.gnome.desktop.interface text-scaling-factor" "org.gnome.desktop.a11y.interface high-contrast" \
                 "org.gnome.mutter experimental-features" "org.gnome.mutter dynamic-workspaces" \
                 "org.gnome.mutter workspaces-only-on-primary" "org.gnome.desktop.wm.preferences button-layout"; do
            # shellcheck disable=SC2086
            printf '%s: %s\n' "$k" "$(gsettings get $k 2>/dev/null)"
        done
    } > "$DIR/system.txt" 2>&1
    if have dconf; then dconf dump "$DCONF_DIR" > "$DIR/guava-settings.txt" 2>&1; fi
}

# The lines that matter, and counts, so the report can be read at a glance
summarize() {
    local j=$DIR/journal.txt
    grep -E 'Guava|JS ERROR|CRITICAL|guava-marker|Segmentation|Stack trace' "$j" > "$DIR/guava-lines.txt" 2>/dev/null
    {
        say "marks:          $(grep -c 'guava-marker' "$j" 2>/dev/null)"
        say "debug lines:    $(grep -c '\[Guava debug\]' "$j" 2>/dev/null)"
        say "JS errors:      $(grep -c 'JS ERROR' "$j" 2>/dev/null)"
        say "criticals:      $(grep -c 'CRITICAL' "$j" 2>/dev/null)"
        say "loop stalls:    $(grep -c 'main loop stall' "$j" 2>/dev/null)"
        say "slow frames:    $(grep -c 'slow frame' "$j" 2>/dev/null)"
        say "worst stalls (ms):"
        grep -o 'main loop stall {ms:[0-9]*' "$j" 2>/dev/null | grep -o '[0-9]*$' | sort -rn | head -5 | tr '\n' ' '; say
    } > "$DIR/summary.txt"
}

pack() {
    local base; base=$(basename "$DIR")
    tar -C "$OUT_ROOT" -czf "$OUT_ROOT/$base.tar.gz" "$base" || die "could not write $OUT_ROOT/$base.tar.gz"
    say ""
    cat "$DIR/summary.txt"
    say ""
    say "Saved: $OUT_ROOT/$base.tar.gz"
    say "(the plain files are in $DIR)"
}

new_dir() {
    local label=${1:-session}
    label=$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-' | head -c 40)
    DIR="$OUT_ROOT/$(date +%Y%m%d-%H%M%S)-$label"
    mkdir -p "$DIR" || die "could not create $DIR"
}

# ---- modes ----------------------------------------------------------------------------------------
record() {
    new_dir "${1:-record}"
    local was; was=$(debug_get)
    system_info
    journalctl --user -f -n 0 -o short-precise "${JOURNAL_MATCH[@]}" > "$DIR/journal.txt" 2>&1 &
    local jpid=$!
    local stopped=0
    finish() {
        [ "$stopped" = 1 ] && return
        stopped=1
        mark "recording stopped"
        # The debug log goes back to how it was
        [ "$was" = true ] || debug_set false
        sleep 1
        kill "$jpid" 2>/dev/null; wait "$jpid" 2>/dev/null
        summarize
        pack
    }
    trap 'finish; exit 0' INT TERM
    sleep 0.5
    debug_set true
    sleep 1
    mark "recording started${1:+: $1}"
    say "Recording. Reproduce the problem now."
    say "Type a note and press Enter to mark a step; type q and press Enter (or Ctrl+C) to stop."
    say "(Screen recording: Ctrl+Shift+Alt+R starts and stops GNOME's own, saved in ~/Videos.)"
    local n=0 line
    while IFS= read -r -p "mark> " line; do
        [ "$line" = q ] && break
        n=$((n + 1))
        mark "$n ${line:-(step)}"
    done
    finish
}

snapshot() {
    new_dir "${1:-snapshot}"
    system_info
    journalctl --user -b -o short-precise "${JOURNAL_MATCH[@]}" > "$DIR/journal.txt" 2>&1
    summarize
    pack
}

case "${1:-record}" in
    record)   shift; record "${1:-}" ;;
    snapshot) shift; snapshot "${1:-}" ;;
    on)       debug_set true;  say "Guava's debug log is on (until you run: $0 off). Collect it with: $0 snapshot" ;;
    off)      debug_set false; say "Guava's debug log is off." ;;
    -h|--help|help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) die "unknown mode '$1' (record, snapshot, on, off, help)" ;;
esac
