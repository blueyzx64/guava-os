# perf-latency.sh: the absolute response-latency metric (D-021). Bundled before perf-suite.sh, which calls
# lat_all once a window exists. Every interaction is real virtual input (pointer / keyboard device, the same
# path as a user); the clock starts at the event that triggers the action and stops at the first stage
# 'after-paint' where the response is visible (an actor mapped with paint opacity > 0, or overview
# progress > 0). Output: "LAT <label> n= miss= min= median= p95= max=" (ms). perf-compare.py: p95 <= 250.
# The harness renders on llvmpipe, so the figure is pessimistic; stock GNOME prints the same lines for the
# actions it has.

_LAT_PRE=$(cat <<'JS'
const find=cls=>{const w=a=>{if(a.has_style_class_name&&a.has_style_class_name(cls))return a;for(const c of a.get_children()){const r=w(c);if(r)return r;}return null;};return w(Main.uiGroup);};
const shown=a=>!!a&&a.mapped&&a.get_paint_opacity()>0;
const ovp=()=>Main.overview.visible&&Main.overview._overview.controls._stateAdjustment.value>0.02;
const ctr=a=>{const [x,y]=a.get_transformed_position();const [w,h]=a.get_transformed_size();return [x+w/2,y+h/2];};
// keys: press in order, release in reverse; mark() runs just before the press of names[pi] or the release of names[ri]
const kk=async(names,mark,pi,ri)=>{const ks=names.map(n=>{const v=Clutter["KEY_"+n];if(typeof v!=="number")throw new Error("unknown key "+n);return v;});
 for(let i=0;i<ks.length;i++){if(i===pi)mark();kvk.notify_keyval(kus(),ks[i],Clutter.KeyState.PRESSED);await sl(25);}
 for(let i=ks.length-1;i>=0;i--){if(i===ri)mark();kvk.notify_keyval(kus(),ks[i],Clutter.KeyState.RELEASED);await sl(25);}};
const kclickM=async(a,mark)=>{const [x,y]=ctr(a);await kmove(x,y);await kmove(x+1,y+1);await kmove(x,y);await sl(100);mark();
 kvp.notify_button(kus(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.PRESSED);await sl(25);kvp.notify_button(kus(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.RELEASED);await sl(25);};
const away=async()=>{await kmove(640,500);};
JS
)

# lat LABEL REPS COND_JS INPUT_JS RESET_JS: INPUT_JS calls mark() right before the triggering event.
lat() {
  local label=$1 reps=$2 cond=$3 input=$4 reset=$5 i r v vals=""
  for ((i = 0; i < reps; i++)); do
    r=$(P "${_KJS_PRE}
${_LAT_PRE}
globalThis.__lat={};
const cond=()=>{try{return !!(${cond})}catch(e){return false}};
if (cond()) return 'LATRES pre';
const T={t0:0,hit:0};
const sid=global.stage.connect('after-paint',()=>{if(T.t0&&!T.hit&&cond())T.hit=GLib.get_monotonic_time();});
const mark=()=>{T.t0=GLib.get_monotonic_time();};
try{ ${input}
}catch(e){ global.stage.disconnect(sid); return 'LATRES err_'+String(e.message).split(' ').join('_'); }
for(let k=0;k<40&&!T.hit;k++) await sl(50);
global.stage.disconnect(sid);
const ms=T.hit?((T.hit-T.t0)/1000).toFixed(1):'miss';
try{ ${reset}
}catch(e){}
return 'LATRES '+ms;" | grep -o 'LATRES [A-Za-z0-9_.-]*' | head -1)
    v=${r#LATRES }
    case "$v" in
      ''|pre|err*|miss) echo "INFO lat-$label rep$i=${v:-none}"; vals="$vals 9999";;
      *) vals="$vals $v";;
    esac
    sleep 0.4
  done
  echo "$vals" | tr ' ' '\n' | grep . | sort -n | awk -v l="$label" '{a[NR]=$1} END{n=NR; m=0; for(i=1;i<=n;i++) if(a[i]>=9999) m++;
    p=int(0.95*n); if(p<0.95*n) p++; if(p<1)p=1;
    printf "LAT %s n=%d miss=%d min=%.1f median=%.1f p95=%.1f max=%.1f\n", l, n, m, a[1], a[int((n+1)/2)], a[p], a[n]}'
}

lat_all() {
  local stock=0; [ -f /opt/guava-stock ] && stock=1
  local reps=${LAT_REPS:-5} esc="await kkey(['Escape']); Main.overview.hide(); await sl(900);"
  # focus the perf window first so the actions behave as with an app in front
  P "const w=kwin('org.x2.Perf'); w?.move_frame(true,300,200); w?.activate(global.get_current_time()); Main.overview.hide(); return 1" >/dev/null; wait_for "!Main.overview.visible" 15 >/dev/null; sleep 1
  # Super tap: Spotlight (Guava), the overview (stock)
  if [ $stock = 1 ]; then
    lat super-tap $reps "ovp()" "await kk(['Super_L'],mark,-1,0);" "$esc"
    lat super-a $reps "ovp()" "await kk(['Super_L','a'],mark,1,-1);" "$esc"
  else
    lat super-tap $reps "shown(find('guava-spotlight-bar'))" "await kk(['Super_L'],mark,-1,0);" "$esc"
    lat mission-control $reps "ovp()" "await kk(['Control_L','Up'],mark,1,-1);" "$esc"
    lat launchpad $reps "shown(find('guava-launchpad'))" "await kk(['Super_L','a'],mark,1,-1);" "await kkey(['Escape']); await sl(900);"
  fi
  # Super+Tab: the app switcher (a second window so there is something to switch to)
  sed 's/org.x2.Perf/org.x2.Perf2/' $W/kperfwin.js >$W/kperfwin2.js
  (WAYLAND_DISPLAY=$WD XDG_RUNTIME_DIR=$W/run GDK_BACKEND=wayland gjs $W/kperfwin2.js >/dev/null 2>&1 9>&- &)
  wait_for "kwin('org.x2.Perf2')!==null" 30 >/dev/null; sleep 1
  lat switcher $reps "shown(find('guava-switcher-popup'))||shown(find('switcher-popup'))" "kvk.notify_keyval(kus(),Clutter.KEY_Super_L,Clutter.KeyState.PRESSED); await sl(80); await kk(['Tab'],mark,0,-1); await sl(500);" "await kkey(['Escape']); kvk.notify_keyval(kus(),Clutter.KEY_Super_L,Clutter.KeyState.RELEASED); await sl(900);"
  # Control Center / Quick Settings, clock (Notification Center): a click on the panel button
  local qs="Main.panel.statusArea.quickSettings" dm="Main.panel.statusArea.dateMenu"
  lat control-center $reps "${qs}.menu.isOpen&&shown(${qs}.menu.actor)" "await kclickM(${qs},mark);" "${qs}.menu.close(); await sl(900);"
  lat clock $reps "(${dm}.menu.isOpen&&shown(${dm}.menu.actor))||(inst('notification-center')?.isOpen&&shown(find('guava-nc')))" "await kclickM(${dm},mark);" "${dm}.menu.close(); inst('notification-center')?.close(); await sl(900);"
  if [ $stock = 0 ]; then
    # an app menu in the menu bar (the first title, else the logo menu)
    lat menu-bar $reps "(()=>{const a=globalThis.__lat.a;return !!a&&a.menu.isOpen&&shown(a.menu.actor);})()" \
      "let b=find('guava-menubar-title')??find('guava-menubar-logo'); while(b&&!b.menu)b=b.get_parent(); globalThis.__lat.a=b; await kclickM(b,mark);" \
      "globalThis.__lat.a?.menu.close(); await sl(900);"
    # dock: a click on the tile of an app that is not running; the response is the tile lifting (launch bounce)
    lat dock-click 3 "(()=>{const it=globalThis.__lat.it;return !!it&&(Math.abs(it.content.translation_y)>0.5||Math.abs(it.content.translation_x)>0.5);})()" \
      "const d=inst('dock'); const sys=Shell.AppSystem.get_default(); for(const [id,it] of d._view._items){const ap=sys.lookup_app(id); if(ap&&ap.get_n_windows()===0&&it.actor.mapped){globalThis.__lat.it=it;break;}} await kclickM(globalThis.__lat.it.actor,mark);" \
      "await away(); await sl(2500); kwins().filter(w=>(w.get_wm_class()||'')!=='org.x2.Perf').forEach(w=>w.delete(global.get_current_time())); await sl(1000);"
    # notch hover: the dashboard opens
    lat notch-hover $reps "shown(find('guava-notch-dash'))" \
      "await away(); await sl(600); const n=find('guava-notch'); const [x,y]=ctr(n); await kmove(x,y+30); await sl(100); mark(); await kmove(x,y);" \
      "await away(); await sl(1500);"
  fi
  # titlebar press, then the first moves: the window follows the pointer (drag start)
  lat drag-start $reps "(()=>{const l=globalThis.__lat;return !!l.a&&Math.abs(l.a.x-l.x0)>2;})()" \
    "const w=kwin('org.x2.Perf'); w.move_frame(true,300,200); w.activate(global.get_current_time()); await sl(500); const a=w.get_compositor_private(); const r=w.get_frame_rect(); const cx=r.x+r.width/2, cy=r.y+18; await kmove(cx,cy); await sl(150); kvp.notify_button(kus(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.PRESSED); await sl(120); globalThis.__lat.a=a; globalThis.__lat.x0=a.x; mark(); kvp.notify_absolute_motion(kus(),cx+14,cy+4); await sl(60); for(let i=1;i<=6;i++){kvp.notify_absolute_motion(kus(),cx+14+i*8,cy+4+i*3); await sl(25);}" \
    "await krelease(); kwin('org.x2.Perf')?.move_frame(true,300,200); await sl(500);"
  # leave only one perf window for the sections that follow
  P "kwin('org.x2.Perf2')?.delete(global.get_current_time()); return 1" >/dev/null; sleep 1.5
}
