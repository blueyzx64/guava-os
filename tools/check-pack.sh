#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Check a packed extension zip: every file the extension imports or loads is in it, and
# nothing of what v3 dropped (apps/, advanced/, css/, coordinators/) or of the files that
# only build or test it (styles/, tests/, docs/, tools/), nor the separate helper package (helpers/) is. (features/*/style.css ride along
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
# Every tracked source the extension can load at run time
while IFS= read -r f; do need "$f"; done < <(git ls-files 'lib/*.js' 'core/*.js' 'features/*.js' 'prefs/*' 'icons/*' \
    'features/*/gtk/*.css')
if grep -E '^(apps|advanced|css|coordinators|styles|tests|docs|tools|helpers)/' <<<"$list"; then
    echo 'zip holds files it must not (above)'; fail=1
fi
[ "$fail" = 0 ] && echo "pack OK: $(wc -l <<<"$list") files"
exit "$fail"
