#!/bin/bash
HARNESS_DIR=${HARNESS_DIR:-$(cd "$(dirname "$0")" && pwd)}
X2=${X2:-/tmp/x2}   # state: roots, locks, runs
REPO=$(cd "$HARNESS_DIR/../.." && pwd)
# Usage: [GUAVA_SRC=dir] [ARCH=$X2/arch] run-real.sh [toggles=20]
# Serialized via flock; outputs in $X2/runs/<ts>-<basename GUAVA_SRC>/ ; $X2/last-run.txt -> latest.
N=${1:-20}
SRC=${GUAVA_SRC:-$REPO}
mkdir -p $X2/runs
if [ -n "$ARCH" ]; then R=$ARCH; exec 9>$X2/run-$(basename $R).lock; flock 9
else
  # two identical Shell 51 roots: take whichever is free
  while :; do
    exec 9>$X2/run.lock;  if flock -n 9; then R=$X2/arch; break; fi; exec 9>&-
    exec 9>$X2/run2.lock; if flock -n 9; then R=$X2/arch2; break; fi; exec 9>&-
    sleep 3
  done
fi
OUT=$X2/runs/$(date +%Y%m%d-%H%M%S)-$(basename "$(cd "$SRC" && pwd)")-$(basename $R)
mkdir -p $OUT
rm -rf $R/opt/guava-src $R/opt/probe $R/opt/shell.log; mkdir -p $R/opt/guava-src $R/opt/probe
(cd $SRC && tar --exclude=.git --exclude=docs --exclude=tests --exclude=po --exclude=tools -cf - .) | tar -xf - -C $R/opt/guava-src
cp "$REPO/tools/smoke/fake-logind.js" $R/opt/fake-logind.js
cp -r "$HARNESS_DIR/probe/probe@x2" $R/opt/probe/
cp "$HARNESS_DIR/inner-real.sh" $R/opt/inner-real.sh
rm -rf $R/opt/guava-extra.sh $R/opt/shots; mkdir -p $R/opt/shots; chmod 777 $R/opt/shots; rm -f $R/opt/guava-pre.sh; [ -n "$GUAVA_PRE" ] && cp "$GUAVA_PRE" $R/opt/guava-pre.sh; [ -n "$GUAVA_EXTRA" ] && cp "$GUAVA_EXTRA" $R/opt/guava-extra.sh
rm -f $R/opt/guava-only; [ -n "$GUAVA_ONLY" ] && echo "$GUAVA_ONLY" > $R/opt/guava-only
ENTER="$HARNESS_DIR/enter.sh"; [ -x $R.enter.sh ] && ENTER=$R.enter.sh; export ARCH_ROOT=$R
trap '"$HARNESS_DIR/killroot.sh" "$R"' EXIT
timeout -k 5 600 $ENTER bash /opt/inner-real.sh $N >$OUT/last-run.txt 2>&1 9>&-
"$HARNESS_DIR/killroot.sh" "$R"
cp $R/opt/shell.log $OUT/shell.log 2>/dev/null
cp -r $R/opt/shots $OUT/shots 2>/dev/null
ln -sfn $OUT/last-run.txt $X2/last-run.txt
python3 -I - $OUT/shell.log <<'PY' | tee -a $OUT/last-run.txt
import re,sys,collections
L=open(sys.argv[1],errors='replace').read().split('\n')
hdr=re.compile(r'(CRITICAL|JS ERROR)');fr=re.compile(r'extensions/guava-os@blueyzx64/([^:\s]+:\d+)')
g=collections.Counter();i=0
while i<len(L):
    if hdr.search(L[i]):
        b=[L[i]];j=i+1
        while j<len(L) and L[j].strip() and not hdr.search(L[j]) and not L[j].startswith('('): b.append(L[j]);j+=1
        t='\n'.join(b);m=fr.search(t)
        if m or '[Guava]' in t:
            msg=re.sub(r'^.*?(CRITICAL|JS ERROR)[^:]*:\s*(\d\d:\d\d:\d\d\.\d+:\s*)?','',L[i])[:120]
            g[(m.group(1) if m else '(no frame)',msg)]+=1
        i=j
    else: i+=1
print('== SUMMARY Guava errors:',sum(g.values()))
for (k,m),c in g.most_common(): print(f'  {c:3d}x {k}  {m}')
PY
grep "^PROBE" $OUT/last-run.txt | cut -c1-260
VALID=1
grep -q "GNOME Shell started\|Running GNOME Shell" $OUT/shell.log 2>/dev/null || VALID=0
grep -q "^('{\"" $OUT/last-run.txt || VALID=0
echo "RUN DIR: $OUT"
[ $VALID = 1 ] || { echo "INVALID RUN: Shell did not start or probe never answered (see $OUT)" | tee -a $OUT/last-run.txt; exit 1; }
