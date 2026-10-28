# guava-swarm-tools/lib.sh: helpers for scenario scripts that run inside the real GNOME Shell.
#
# Use: bundle it with your scenario (bundle.sh), then pass the bundle as GUAVA_EXTRA.
# The harness copies only one file into the chroot, so lib.sh cannot be sourced by path.
#
# Harness names used here (set by /tmp/x2/inner-real.sh before GUAVA_EXTRA runs):
#   P 'js'   evaluate JS in the Shell (async body, `return` a value); W, WD, HOME (session env).
#   SHOT     not used; shot() writes /opt/shots/<name>.png itself.
#
# Every Shell-side function builds on _kjs, which prepends _KJS_PRE: sl(ms), inst(id),
# kwins(), kwin(cls), a virtual pointer and keyboard, and the click/drag/key helpers.
#
# Output conventions (grep these in the run log):
#   LAUNCH OK|FAIL <cls> ...    FOCUS OK|FAIL <cls>    CLICK x,y    DRAG x1,y1->x2,y2
#   ASSERT PASS|FAIL <name> <detail>    SHOT <name> -> shots/<name>.png
#   ANIMATIONS on|off enable_animations=<bool>

GUAVA_ASSERT_PASS=${GUAVA_ASSERT_PASS:-0}
GUAVA_ASSERT_FAIL=${GUAVA_ASSERT_FAIL:-0}

_KJS_PRE=$(cat <<'JS'
const sl=ms=>new Promise(r=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{r();return GLib.SOURCE_REMOVE}));
const inst=id=>{try{return Main.extensionManager.lookup("guava-os@blueyzx64").stateObj._features._state.get(id)?.instance??null}catch(e){return null}};
const kwins=()=>global.get_window_actors().filter(a=>a.mapped).map(a=>a.meta_window).filter(w=>w.get_window_type()===Meta.WindowType.NORMAL);
const kwin=c=>kwins().find(w=>(w.get_wm_class()||"").toLowerCase()===String(c).toLowerCase())??null;
const kseat=Clutter.get_default_backend().get_default_seat();
globalThis.__kvp??=kseat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
globalThis.__kvk??=kseat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
const kvp=globalThis.__kvp, kvk=globalThis.__kvk;
const kus=()=>GLib.get_monotonic_time();
const kmove=async(x,y)=>{kvp.notify_absolute_motion(kus(),x,y);await sl(40);};
const kpress=async()=>{kvp.notify_button(kus(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.PRESSED);await sl(60);};
const krelease=async()=>{kvp.notify_button(kus(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.RELEASED);await sl(150);};
// Priming: move onto the target and wiggle by 1px before the press, so the Shell has a
// pointer-enter on the actor. Without it the first press after the device is created is often dropped.
const kclick=async(x,y)=>{await kmove(x,y);await kmove(x+1,y+1);await kmove(x,y);await sl(80);await kpress();await krelease();};
const kdrag=async(x1,y1,x2,y2,steps=24)=>{await kmove(x1,y1);await sl(120);await kpress();await sl(80);for(let i=1;i<=steps;i++){await kmove(x1+(x2-x1)*i/steps,y1+(y2-y1)*i/steps);}await sl(200);await krelease();};
const kkey=async names=>{const ks=names.map(n=>{const v=Clutter["KEY_"+n];if(typeof v!=="number")throw new Error("unknown key "+n);return v;});for(const k of ks){kvk.notify_keyval(kus(),k,Clutter.KeyState.PRESSED);await sl(30);}for(const k of [...ks].reverse()){kvk.notify_keyval(kus(),k,Clutter.KeyState.RELEASED);await sl(30);}await sl(200);};
JS
)

# _kjs BODY: run BODY (JS statements, may await, must return) in the Shell. Prints P's raw output.
_kjs() { P "${_KJS_PRE}
$1"; }

# launch_app CMD WM_CLASS [TIMEOUT_S=40]
#   Start CMD (a shell command line) with the session's Wayland display, then wait until a
#   mapped normal window with that wm_class exists. Case-insensitive match. Logs go to $W/app-<tag>.log.
#   Example: launch_app "gnome-text-editor" org.gnome.TextEditor 30
#   Example with preload: launch_app "env LD_PRELOAD=$W/uid.so nautilus --new-window /tmp" org.gnome.Nautilus
launch_app() {
  local cmd=$1 cls=$2 to=${3:-40} tag r i
  tag=$(printf '%s' "$cls" | tr -c 'A-Za-z0-9' _)
  local wd=${WD:-$(ls "$W/run" 2>/dev/null | grep -m1 '^wayland-[0-9]*$')}
  (cd "$W/home" && env HOME="$HOME" WAYLAND_DISPLAY="$wd" XDG_RUNTIME_DIR="$W/run" GDK_BACKEND=wayland NO_AT_BRIDGE=1 \
     bash -c "$cmd" >"$W/app-$tag.log" 2>&1 9>&- &)
  for ((i=0; i<to; i++)); do
    r=$(_kjs "return kwin('$cls')!==null")
    case "$r" in *"('true',)"*) sleep 1.5; echo "LAUNCH OK $cls after ${i}s"; return 0;; esac
    sleep 1
  done
  echo "LAUNCH FAIL $cls no window after ${to}s (log: $W/app-$tag.log)"
  tail -5 "$W/app-$tag.log" 2>/dev/null
  return 1
}

# focus_app WM_CLASS
#   Activate the first normal window of that class and check that it has focus.
focus_app() {
  local cls=$1 r
  r=$(_kjs "const w=kwin('$cls'); if(!w) return 'NOWIN'; w.activate(global.get_current_time()); await sl(700); return global.display.focus_window===w?'FOCUSED':'NOTFOCUSED';")
  case "$r" in
    *NOTFOCUSED*) echo "FOCUS FAIL $cls (window exists, not focused)"; return 1;;
    *FOCUSED*) echo "FOCUS OK $cls"; return 0;;
    *) echo "FOCUS FAIL $cls (no window)"; return 1;;
  esac
}

# click_at X Y
#   Virtual pointer click on the stage coordinates X,Y (with the priming move, see lib JS).
click_at() {
  _kjs "await kclick($1,$2); return 'ok';" >/dev/null
  echo "CLICK $1,$2"
}

# click_actor JS_EXPR
#   JS_EXPR evaluates to an actor. Clicks the centre of its transformed box.
#   Prints CLICK x,y, or NOACTOR if the expression is null.
#   Example: click_actor "Main.panel.statusArea.quickSettings.menu._grid"
click_actor() {
  local r
  r=$(_kjs "const __a=(${1}); if(!__a) return 'NOACTOR'; const [__x,__y]=__a.get_transformed_position(); const [__w,__h]=__a.get_transformed_size(); const __cx=Math.round(__x+__w/2), __cy=Math.round(__y+__h/2); await kclick(__cx,__cy); return 'CLICK '+__cx+','+__cy;")
  case "$r" in
    *NOACTOR*) echo "NOACTOR";;
    *CLICK*) printf '%s\n' "$r" | grep -o 'CLICK [0-9,]*' | head -1;;
    *) echo "CLICK FAIL $r";;
  esac
}

# drag X1 Y1 X2 Y2
#   Press at X1,Y1, move in 24 steps to X2,Y2, release.
drag() {
  _kjs "await kdrag($1,$2,$3,$4); return 'ok';" >/dev/null
  echo "DRAG $1,$2->$3,$4"
}

# key COMBO
#   Virtual keyboard. COMBO is keys joined with +, pressed in order and released in reverse.
#   Modifier names: super, ctrl, alt, shift. Others are Clutter key names (Escape, Return, F10,
#   Right, d, ...). Example: key super+d   key ctrl+alt+t   key Escape
key() {
  local combo=$1 p n js="" parts
  IFS=+ read -ra parts <<<"$combo"
  for p in "${parts[@]}"; do
    case "$(printf '%s' "$p" | tr A-Z a-z)" in
      super|meta|win) n=Super_L;;
      ctrl|control) n=Control_L;;
      alt) n=Alt_L;;
      shift) n=Shift_L;;
      esc|escape) n=Escape;;
      enter|return) n=Return;;
      *) n=$p;;
    esac
    js+="\"$n\","
  done
  js=${js%,}
  _kjs "await kkey([$js]); return 'ok';" >/dev/null
  echo "KEY $combo"
}

# wait_for JS_EXPR [TIMEOUT_S=10]
#   Poll until JS_EXPR is truthy. Returns 0 on success, 1 on timeout.
wait_for() {
  local js=$1 to=${2:-10} i r
  for ((i=0; i<to*4; i++)); do
    r=$(_kjs "return !!(${js})")
    case "$r" in *"('true',)"*) echo "WAIT OK after $((i/4)).$(( (i%4)*25 ))s: $js"; return 0;; esac
    sleep 0.25
  done
  echo "WAIT TIMEOUT ${to}s: $js"
  return 1
}

# assert NAME JS_EXPR
#   Evaluate JS_EXPR (an expression); truthy is PASS. Prints ASSERT PASS|FAIL NAME DETAIL.
#   DETAIL is the value (objects print as <ClassName>). Counts go to GUAVA_ASSERT_PASS/FAIL.
assert() {
  local name=$1 expr=$2 r v d
  r=$(_kjs "const __v=(${expr}); const __d=(typeof __v==='object'&&__v!==null)?('<'+(__v.constructor?.name??'object')+'>'):String(__v); return (__v?'PASS':'FAIL')+':'+__d.replace(/\\s+/g,' ').slice(0,300);")
  case "$r" in
    *\"PASS:*) v=PASS;;
    *) v=FAIL;;
  esac
  d=$(printf '%s' "$r" | sed -e 's/^.*\(PASS\|FAIL\)://' -e "s/\"',)\$//")
  [ -n "$d" ] || d=$(printf '%s' "$r" | cut -c1-200)
  if [ $v = PASS ]; then GUAVA_ASSERT_PASS=$((GUAVA_ASSERT_PASS+1)); else GUAVA_ASSERT_FAIL=$((GUAVA_ASSERT_FAIL+1)); fi
  echo "ASSERT $v $name $d"
  [ $v = PASS ]
}

# assert_summary: one line with the totals. Call it last in a scenario.
assert_summary() { echo "ASSERT SUMMARY pass=$GUAVA_ASSERT_PASS fail=$GUAVA_ASSERT_FAIL"; }

# shot NAME: full-screen PNG at shots/NAME.png in the run directory.
shot() {
  _kjs "const f=Gio.File.new_for_path('/opt/shots/$1.png'); const s=f.replace(null,false,0,null); const sh=new Shell.Screenshot(); await new Promise((res,rej)=>sh.screenshot(false,s,(o,r)=>{try{o.screenshot_finish(r);res()}catch(e){rej(e)}})); s.close(null); return 'ok';" >/dev/null
  echo "SHOT $1 -> shots/$1.png"
}

# force_animations on|off
#   Sets org.gnome.desktop.interface enable-animations and, for on, uninhibits St animations.
#   Reads back St.Settings.get().enable_animations to confirm.
force_animations() {
  local v
  case "$1" in on) v=true;; off) v=false;; *) echo "usage: force_animations on|off" >&2; return 2;; esac
  gsettings set org.gnome.desktop.interface enable-animations $v 2>&1
  [ $v = true ] && _kjs "St.Settings.get().uninhibit_animations(); return 'ok';" >/dev/null
  sleep 0.5
  r=$(_kjs "return St.Settings.get().enable_animations")
  case "$r" in *"('true',)"*) v=true;; *) v=false;; esac
  echo "ANIMATIONS $1: enable_animations=$v"
}
