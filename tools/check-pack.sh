#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Check a packed extension zip: every file the extension imports or loads is in it, and
# nothing of what v3 dropped (apps/, advanced/, css/, coordinators/) or of the files that
# only build or test it (styles/, tests/, docs/, tools/), nor the separate helper package (packaging/) is. (features/*/style.css ride along
# with --extra-source=features; the Shell loads only stylesheet.css.)
#   tools/check-pack.sh dist/guava-os@blueyzx64.shell-extension.zip
set -euo pipefail
zip=${1:?zip path}
cd "$(dirname "$0")/.."
list=$(unzip -Z1 "$zip")
fail=0
need() { grep -qx -- "$1" <<<"$list" || { echo "missing in zip: $1"; fail=1; }; }
for f in metadata.json extension.js prefs.js features.js stylesheet.css \
         schemas/org.gnome.shell.extensions.guava-os.gschema.xml; do
    need "$f"
done
# Every tracked source the extension can load at run time. Listed first, so a missing git (or
# any git failure) stops the check instead of silently checking nothing.
# Sources live under src/ (the zip's root): list them there and drop the prefix
sources=$(git ls-files 'src/lib/*.js' 'src/core/*.js' 'src/features/*.js' 'src/prefs/*' 'src/icons/*' 'src/features/*/gtk/*.css' 'src/features/*/lucidglyph/*.conf' | sed 's|^src/||')
[ -n "$sources" ] || { echo "check-pack: git listed no sources (is this a git checkout?)"; exit 2; }
while IFS= read -r f; do need "$f"; done <<<"$sources"
if grep -E '^(apps|advanced|css|coordinators|styles|tests|docs|tools|helpers|packaging|i18n|src)/' <<<"$list"; then
    echo 'zip holds files it must not (above)'; fail=1
fi
[ "$fail" = 0 ] && echo "pack OK: $(wc -l <<<"$list") files"
exit "$fail"
