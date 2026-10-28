#!/bin/bash
# safe-rm.sh <chroot dir>: unmount everything under it, refuse if anything still mounted, then rm -rf.
X2=${X2:-/tmp/x2}; D=$(readlink -f "$1"); case "$D" in "$X2"/f44*|"$X2"/arch*) ;; *) echo bad path; exit 1;; esac
"$(dirname "$0")/killroot.sh" "$D"; sleep 1; for i in 1 2 3 4 5 6 7 8; do umount -R "$D" 2>/dev/null || umount -l -R "$D" 2>/dev/null; done
if grep -q " $D" /proc/mounts; then echo "STILL MOUNTED, refusing"; exit 1; fi
rm -rf --one-file-system "$D"
