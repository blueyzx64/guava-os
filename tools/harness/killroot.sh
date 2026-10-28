#!/bin/bash
# killroot.sh <chroot>: kill every process whose root is exactly this chroot (or below it)
R=${1%/}
for p in /proc/[0-9]*; do r=$(readlink $p/root 2>/dev/null); case "$r" in "$R"|"$R"/*) kill -9 ${p#/proc/} 2>/dev/null;; esac; done
