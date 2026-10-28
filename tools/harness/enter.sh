#!/bin/bash
# usage: enter.sh cmd...   Private tmpfs /dev (NEVER bind host devtmpfs: rm under it wipes host /dev).
R=${ARCH_ROOT:?set ARCH_ROOT to a test root}
mountpoint -q $R || mount --bind $R $R
mountpoint -q $R/proc || mount -t proc proc $R/proc
mountpoint -q $R/sys || mount --rbind /sys $R/sys
if ! mountpoint -q $R/dev; then
  mount -t tmpfs -o mode=755,nosuid tmpfs $R/dev
  for n in null:1:3 zero:1:5 full:1:7 random:1:8 urandom:1:9 tty:5:0; do IFS=: read a b c <<<$n; mknod -m 666 $R/dev/$a c $b $c; done
  mkdir -p $R/dev/pts $R/dev/shm
  mount -t devpts devpts $R/dev/pts -o newinstance,ptmxmode=0666
  mount -t tmpfs tmpfs $R/dev/shm
  ln -sf /proc/self/fd $R/dev/fd; ln -sf /proc/self/fd/0 $R/dev/stdin; ln -sf /proc/self/fd/1 $R/dev/stdout; ln -sf /proc/self/fd/2 $R/dev/stderr; ln -sf pts/ptmx $R/dev/ptmx
fi
mountpoint -q $R/tmp || mount -t tmpfs tmpfs $R/tmp
exec chroot $R /usr/bin/env -i HOME=/root TERM=xterm PATH=/usr/local/bin:/usr/bin https_proxy=$HTTPS_PROXY HTTPS_PROXY=$HTTPS_PROXY http_proxy=$HTTP_PROXY CURL_CA_BUNDLE=/etc/ssl/certs/ccr.pem SSL_CERT_FILE=/etc/ssl/certs/ccr.pem "$@"
