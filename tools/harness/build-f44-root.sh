#!/bin/bash
# build-f44-root.sh <name> [count]: build Fedora 44 / GNOME Shell 50 test roots under $X2.
#   build-f44-root.sh f44        -> $X2/f44 and $X2/f44.enter.sh
#   build-f44-root.sh f44 8      -> $X2/f44, f44b … f44h (copies of the first, for parallel runs)
# Needs root (chroot, mounts), curl, tar, xz and network access. Run on a Linux host or VM, never
# on a machine whose /dev you care about: enter.sh gives each root a private tmpfs /dev.
set -euo pipefail
HARNESS_DIR=$(cd "$(dirname "$0")" && pwd)
X2=${X2:-/tmp/x2}
NAME=${1:?root name, e.g. f44}
COUNT=${2:-1}
IMAGE_URL=${IMAGE_URL:-https://download.fedoraproject.org/pub/fedora/linux/releases/44/Container/x86_64/images/Fedora-Container-Base-Generic-44-1.7.x86_64.oci.tar.xz}
# The packages the probes and scenarios use (GNOME Shell 50, real apps, D-Bus mocks, Xwayland)
PACKAGES="gnome-shell mutter gjs gtk4 gsettings-desktop-schemas dbus-daemon libnotify
  gnome-text-editor gnome-calculator nautilus rhythmbox sushi qt6-designer glycin-thumbnailer
  pipewire-pulseaudio python3-dbusmock xorg-x11-server-Xwayland procps-ng util-linux-core sudo"

R=$X2/$NAME
mkdir -p "$X2"
[ -e "$R" ] && { echo "$R exists; remove it with safe-rm.sh first"; exit 1; }

work=$(mktemp -d "$X2/oci.XXXX")
curl -fL "$IMAGE_URL" -o "$work/image.oci.tar.xz"
mkdir -p "$work/oci" && tar -xJf "$work/image.oci.tar.xz" -C "$work/oci"
# The OCI image has one layer: the largest blob is the root filesystem
layer=$(ls -S "$work"/oci/blobs/sha256/* | head -n1)
mkdir -p "$R" && tar -xf "$layer" -C "$R"
rm -rf "$work"

cp /etc/resolv.conf "$R/etc/resolv.conf"
# Behind a TLS-intercepting proxy, put its CA bundle at $CA_BUNDLE (enter.sh points curl/dnf at it)
mkdir -p "$R/etc/ssl/certs"; [ -n "${CA_BUNDLE:-}" ] && cp "$CA_BUNDLE" "$R/etc/ssl/certs/ccr.pem"
printf '#!/bin/bash\nARCH_ROOT=%s exec %s/enter.sh "$@"\n' "$R" "$HARNESS_DIR" > "$X2/$NAME.enter.sh"
chmod +x "$X2/$NAME.enter.sh"

proxy=${HTTPS_PROXY:+--setopt=proxy=$HTTPS_PROXY}
# shellcheck disable=SC2086
"$X2/$NAME.enter.sh" bash -c "dnf -y $proxy --setopt=install_weak_deps=False install $(echo $PACKAGES) && gnome-shell --version"

# Extra roots for parallel runs: copy the first one (never cross a mount: -x)
for s in b c d e f g h; do
  [ "$COUNT" -le 1 ] && break
  COUNT=$((COUNT - 1))
  cp -ax "$R" "$X2/$NAME$s"
  printf '#!/bin/bash\nARCH_ROOT=%s exec %s/enter.sh "$@"\n' "$X2/$NAME$s" "$HARNESS_DIR" > "$X2/$NAME$s.enter.sh"
  chmod +x "$X2/$NAME$s.enter.sh"
done
echo "built $R (and copies); run: GUAVA_SRC=\$PWD $HARNESS_DIR/run-f44.sh 20"
