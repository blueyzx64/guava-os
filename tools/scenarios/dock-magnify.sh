# Scenario for the real-Shell harness (GUAVA_EXTRA, bundle after tools/harness/lib/lib.sh).
# B18 magnification shows sharp icons: app icons are drawn at the magnified size (texture 96 for a
#     48 px icon, shown at 48), so the 2x icon is a native bitmap, not a 48 px one stretched.
# B28 magnification is off while the Shell is degraded (motion env), back when it clears.
force_animations on
gs dock-magnification true
gs dock-magnification-size 96
sleep 2
H='const D=()=>inst("dock"); const apps=()=>[...D()._view.items()].filter(i=>i.app); const first=()=>apps()[0];
const ctr=()=>{const [x,y]=first().actor.get_transformed_position(); const [w,h]=[first().actor.width,first().actor.height]; return [x+w/2,y+h/2];};
const M=()=>D()._magnifier;
const degrade=on=>{const e=Main.extensionManager.lookup("guava-os@blueyzx64").stateObj; e._motion._env={...e._motion._env,degraded:on}; e._events.emit("motion-changed",{...e._motion._env});};'
J() { _kjs "$H $1"; }

echo "-- B18 texture size"
assert "app icon drawn at 96 px, shown at 48" "(()=>{const i=[...inst('dock')._view.items()].find(i=>i.app); return i._icon.icon_size===96 && i._icon.width===48 && i._icon.height===48;})()"
J 'const c=ctr(); await kmove(c[0],c[1]); await sl(900); return 1' >/dev/null
assert "hover magnifies the icon (scale > 1.5, texture still 96)" "(()=>{const i=[...inst('dock')._view.items()].find(i=>i.app); return i.actor.scale_x>1.5 && i._icon.icon_size===96;})()"
shot dock-magnified

echo "-- B28 degraded"
J 'degrade(true); await sl(700); return 1' >/dev/null
assert "degraded: magnifier at rest (scale 1)" "(()=>{const d=inst('dock'); return !d._magnifier.active && [...d._view.items()].find(i=>i.app).actor.scale_x===1;})()"
J 'const c=ctr(); await kmove(c[0]+3,c[1]+2); await sl(600); return 1' >/dev/null
assert "degraded: pointer over the dock does not magnify" "[...inst('dock')._view.items()].find(i=>i.app).actor.scale_x===1"
J 'degrade(false); await sl(900); const c=ctr(); await kmove(c[0],c[1]); await sl(500); return 1' >/dev/null
assert "clear: magnification returns" "[...inst('dock')._view.items()].find(i=>i.app).actor.scale_x>1.5"

echo "-- B18 option off"
J 'await kmove(640,300); await sl(500); return 1' >/dev/null
gs dock-magnification false
sleep 1
assert "magnification off: icons drawn at 48" "[...inst('dock')._view.items()].find(i=>i.app)._icon.icon_size===48"
assert_summary
